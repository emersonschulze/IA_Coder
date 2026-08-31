import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Abre o seletor de pastas do Windows e devolve o caminho escolhido.
 *
 * Duas tentativas, porque cada uma falha de um jeito diferente:
 *
 * 1. Shell.Application.BrowseForFolder (COM) — é o diálogo clássico do
 *    Explorer. Aparece de forma confiável e não depende do WinForms.
 * 2. FolderBrowserDialog (.NET) — visual mais moderno, mas precisa de um dono
 *    de janela válido, senão abre ATRÁS do navegador e parece que nada
 *    aconteceu. Forçamos a criação do handle antes de usar como dono.
 *
 * Os dois exigem apartamento STA, daí o -Sta no powershell.exe.
 */
export async function pickFolderNative(startAt?: string): Promise<string | null> {
  if (process.platform !== 'win32') {
    throw new Error('O seletor de pastas nativo só existe no Windows.');
  }

  const start = (startAt ?? '').replace(/'/g, "''");

  const script = `
$ErrorActionPreference = 'Stop'
$chosen = $null

# 1) Diálogo clássico do Explorer (COM).
try {
  $shell = New-Object -ComObject Shell.Application
  # 0x0001 só pastas do sistema de arquivos | 0x0010 caixa de edição | 0x0040 visual novo
  $folder = $shell.BrowseForFolder(0, 'Escolha a pasta do projeto', 81, '${start}')
  if ($folder) { $chosen = $folder.Self.Path }
} catch {
  Write-Error "COM: $($_.Exception.Message)"
}

# 2) Alternativa em WinForms, caso o COM não esteja disponível.
if (-not $chosen) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $owner = New-Object System.Windows.Forms.Form
    $owner.TopMost = $true
    $owner.ShowInTaskbar = $false
    $owner.Opacity = 0
    $owner.StartPosition = 'CenterScreen'
    $null = $owner.Handle   # sem handle, o diálogo abre atrás de tudo
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Escolha a pasta do projeto'
    $dialog.ShowNewFolderButton = $true
    if ('${start}' -ne '') { $dialog.SelectedPath = '${start}' }
    if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
      $chosen = $dialog.SelectedPath
    }
    $owner.Dispose()
  } catch {
    Write-Error "WinForms: $($_.Exception.Message)"
  }
}

if ($chosen) { Write-Output "<<PASTA>>$chosen" }
`.trim();

  const { stdout, stderr } = await run(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, timeout: 300_000, maxBuffer: 1024 * 64 },
  );

  if (stderr.trim()) console.warn('[picker]', stderr.trim());

  // O marcador evita confundir a resposta com qualquer ruído do perfil do shell.
  const match = stdout.match(/<<PASTA>>(.+)/);
  return match ? match[1].trim() : null;
}

/**
 * Abre um artefato com o programa padrão do Windows.
 *
 * O navegador não abre caminho local (`file://` é bloqueado), então quem abre é
 * o servidor — que roda na sua máquina. `explorer.exe /select` revela o arquivo
 * na pasta; sem a flag, abre no programa associado.
 */
export function openArtifact(path: string, reveal = false): void {
  if (process.platform !== 'win32') {
    throw new Error('Abrir arquivos assim só funciona no Windows.');
  }
  const safe = path.replace(/"/g, '');
  const line = reveal
    ? `explorer.exe /select,"${safe}"`
    : `start "" "${safe}"`;
  const child = spawn(line, { shell: true, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}
