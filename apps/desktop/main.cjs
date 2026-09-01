// Processo principal do Electron.
//
// O que este arquivo faz, em ordem:
//   1. acha a raiz do projeto (instalado ou em desenvolvimento);
//   2. garante que exista um `.env` e uma pasta `workspace/` graváveis;
//   3. checa se o Docker está de pé (Postgres/Redis moram lá);
//   4. sobe o servidor (apps/server) usando o Node embutido no próprio
//      Electron — ninguém precisa instalar Node.js à parte;
//   5. espera a porta do WebSocket responder;
//   6. abre a janela com o frontend já compilado (apps/web/dist).
//
// Sem isso, "rodar o IA_Coder" significava abrir dois terminais (server e
// web) e uma aba do navegador à mão, toda vez. Aqui é um ícone.

const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

/** Raiz do projeto: onde ficam `apps/`, `docker-compose.yml`, `.env`. */
const repoRoot = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, '..', '..');

const serverDir = path.join(repoRoot, 'apps', 'server');
const webIndex = path.join(repoRoot, 'apps', 'web', 'dist', 'index.html');
const envFile = path.join(repoRoot, '.env');
const envExample = path.join(repoRoot, '.env.example');
const workspaceDir = path.join(repoRoot, 'workspace');
const logFile = path.join(app.getPath('userData'), 'server.log');

let splashWindow = null;
let mainWindow = null;
let serverProcess = null;

/** Primeira execução: sem isso o servidor não acha `POSTGRES_*`, `SERVER_PORT` etc. */
function ensureEnvFile() {
  if (!fs.existsSync(envFile) && fs.existsSync(envExample)) {
    fs.copyFileSync(envExample, envFile);
  }
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'artifacts'), { recursive: true });
}

/** `docker info` sem terminal — só interessa se respondeu com código 0. */
function dockerIsRunning() {
  try {
    const result = spawnSync('docker', ['info'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Sobe Postgres + Redis se o Docker estiver de pé e o compose existir. */
function startDockerServices() {
  const composeFile = path.join(repoRoot, 'docker-compose.yml');
  if (!fs.existsSync(composeFile)) return;
  try {
    spawnSync('docker', ['compose', '-f', composeFile, 'up', '-d'], {
      cwd: repoRoot,
      stdio: 'ignore',
      windowsHide: true,
      timeout: 30000,
    });
  } catch {
    // Não bloqueia a abertura do app — o Tree mostra "banco offline" e
    // reconecta sozinho assim que o Postgres subir.
  }
}

/*
 * Sem Docker instalado, Postgres e Redis não sobem — mas o restante do
 * IA_Coder (conversa com o Claude, terminal, Tree em modo degradado) ainda
 * funciona. Por isso o aviso é só informativo: quem clicar em "Continuar"
 * chega até a janela principal do mesmo jeito.
 */
function warnIfNoDocker() {
  if (dockerIsRunning()) {
    startDockerServices();
    return;
  }
  const hasDockerCli = (() => {
    try {
      return spawnSync('docker', ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0;
    } catch {
      return false;
    }
  })();

  const detail = hasDockerCli
    ? 'O Docker Desktop está instalado, mas não parece estar rodando. Abra o Docker Desktop e reinicie o IA_Coder para ter o banco (Tree) e o Redis disponíveis.'
    : 'O Docker não foi encontrado. O Tree (memória de longo prazo) e o modo conversa (Whisper/Piper) dependem dele. Instale o Docker Desktop e rode "docker compose up -d" na pasta do projeto.';

  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: 'IA_Coder — Docker não detectado',
    message: 'O IA_Coder abre mesmo assim, mas sem o Docker o Tree fica offline.',
    detail,
    buttons: ['Abrir mesmo assim', 'Baixar Docker Desktop', 'Sair'],
    defaultId: 0,
    cancelId: 0,
  });

  if (choice === 1) {
    shell.openExternal('https://www.docker.com/products/docker-desktop/');
  }
  if (choice === 2) {
    app.quit();
  }
}

function updateSplash(text) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents
      .executeJavaScript(`document.getElementById('status').textContent = ${JSON.stringify(text)};`)
      .catch(() => {});
  }
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 260,
    frame: false,
    resizable: false,
    center: true,
    backgroundColor: '#03060c',
    webPreferences: { contextIsolation: true },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
}

/** Sobe `apps/server` com o Node embutido no Electron (ELECTRON_RUN_AS_NODE). */
function startServer() {
  const tsxCli = path.join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!fs.existsSync(tsxCli)) {
    dialog.showErrorBox(
      'IA_Coder — instalação incompleta',
      `Não encontrei ${tsxCli}.\n\nRode "npm install" dentro de apps/server antes de empacotar o instalador.`,
    );
    app.quit();
    return null;
  }

  const child = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
    cwd: serverDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log = fs.createWriteStream(logFile, { flags: 'a' });
  log.write(`\n--- IA_Coder server iniciado em ${new Date().toISOString()} ---\n`);
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });

  child.on('exit', (code) => {
    log.write(`--- servidor encerrou (código ${code}) ---\n`);
    if (mainWindow && !mainWindow.isDestroyed() && code !== 0) {
      dialog.showErrorBox(
        'IA_Coder — o servidor caiu',
        `O processo do servidor encerrou (código ${code}). Veja o log em:\n${logFile}`,
      );
    }
  });

  return child;
}

/** Espera `host:port` aceitar conexão — é assim que sabemos que o WS subiu. */
function waitForPort(host, port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host, port }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`timeout esperando ${host}:${port}`));
        } else {
          setTimeout(attempt, 400);
        }
      });
    };
    attempt();
  });
}

function readServerAddress() {
  // Mesmos padrões de apps/server/src/config.ts.
  const port = Number(process.env.SERVER_PORT) || 8787;
  const host = process.env.SERVER_HOST || '127.0.0.1';
  return { host, port };
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#03060c',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });

  if (app.isPackaged) {
    await mainWindow.loadFile(webIndex);
  } else {
    // Em desenvolvimento, quem serve o frontend é o Vite (`npm run dev` em
    // apps/web) — este processo só embrulha a janela.
    await mainWindow.loadURL('http://localhost:5173');
  }

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    mainWindow.show();
  });
}

function killServer() {
  if (!serverProcess || serverProcess.killed) return;
  if (process.platform === 'win32') {
    // `child.kill()` mata só o processo do tsx; o Node que ele sobe por
    // baixo (via ELECTRON_RUN_AS_NODE são o mesmo processo, então isto já
    // basta) — mas `/t` garante que nada fique órfão se algo mudar.
    spawnSync('taskkill', ['/pid', String(serverProcess.pid), '/t', '/f'], { windowsHide: true });
  } else {
    serverProcess.kill('SIGTERM');
  }
}

app.whenReady().then(async () => {
  ensureEnvFile();
  createSplash();
  updateSplash('checando Docker (Postgres, Redis)…');
  warnIfNoDocker();

  updateSplash('abrindo o servidor…');
  serverProcess = startServer();
  if (!serverProcess) return;

  const { host, port } = readServerAddress();
  try {
    await waitForPort(host, port, 45000);
  } catch (error) {
    dialog.showErrorBox(
      'IA_Coder — o servidor não respondeu',
      `Esperei 45s por ${host}:${port} e nada.\n\nVeja o log em:\n${logFile}`,
    );
    app.quit();
    return;
  }

  updateSplash('pronto — abrindo a janela…');
  await createMainWindow();
});

app.on('window-all-closed', () => {
  killServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', killServer);
