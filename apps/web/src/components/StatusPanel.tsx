import { useEffect, useState } from 'react';
import { compactTokens, money, pct } from '@/lib/format';
import { useSession } from '@/store/useSession';
import { Panel, PanelBody } from './Panel';
import styles from './Panels.module.css';

const CIRCUMFERENCE = 2 * Math.PI * 24;

/** Só o conteúdo, sem a casca do painel — usado sozinho e dentro do painel com abas. */
export function StatusBody() {
  const usage = useSession((state) => state.usage);

  // Um tique por minuto só para o "há X min" e a contagem regressiva andarem.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((value) => value + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // O `windowPct`/`weekPct` vêm direto da conta na Anthropic (5h e semana) —
  // é o número de verdade, o mesmo do `/usage` do Claude Code. Só caímos para
  // tokens desta sessão se essa busca nunca respondeu (ex.: sem credencial).
  const windowPct = usage.windowPct;
  const weekPct = usage.weekPct;
  const planPct =
    windowPct !== undefined
      ? pct(windowPct)
      : usage.tokensLimit > 0
        ? pct((usage.tokensUsed / usage.tokensLimit) * 100)
        : 0;
  const costPct = pct(usage.costUsd * 4);
  const resets = usage.windowResetsAt
    ? new Date(usage.windowResetsAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : null;
  const weekResets = usage.weekResetsAt
    ? new Date(usage.weekResetsAt).toLocaleDateString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    : null;
  const remaining = usage.windowResetsAt
    ? Math.max(0, Math.round((usage.windowResetsAt - Date.now()) / 60000))
    : null;
  const age = usage.updatedAt
    ? Math.max(0, Math.round((Date.now() - usage.updatedAt) / 60000))
    : null;

  return (
    <PanelBody>
      <div className={styles.gauge}>
        <svg width="58" height="58" viewBox="0 0 58 58" aria-hidden>
          <circle cx="29" cy="29" r="24" fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="5" />
          <circle
            cx="29"
            cy="29"
            r="24"
            fill="none"
            stroke="url(#statusGradient)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE - (CIRCUMFERENCE * planPct) / 100}
            style={{ transition: 'stroke-dashoffset .6s var(--ease)' }}
          />
          <defs>
            <linearGradient id="statusGradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#22d3ee" />
              <stop offset="1" stopColor="#a855f7" />
            </linearGradient>
          </defs>
        </svg>
        <div>
          <div className={styles.gaugeLabel}>
            {windowPct !== undefined ? 'CONSUMO DA CONTA · 5H' : 'CONSUMO DA SESSÃO'}
          </div>
          <div className={styles.gaugeValue}>{Math.round(planPct)}%</div>
          {age !== null && (
            <div className={styles.gaugeLabel}>
              {age === 0 ? 'agora mesmo' : `há ${age} min`}
              {remaining !== null && ` · zera em ${Math.floor(remaining / 60)}h${String(remaining % 60).padStart(2, '0')}`}
            </div>
          )}
        </div>
      </div>

      <Meter
        label={resets ? `JANELA DE 5H · VOLTA ${resets}` : 'LIMITE DO PLANO'}
        value={windowPct !== undefined ? `${Math.round(windowPct)}%` : `${compactTokens(usage.tokensUsed)} / ${compactTokens(usage.tokensLimit)}`}
        percent={planPct}
      />
      {weekPct !== undefined && (
        <Meter
          label={weekResets ? `LIMITE SEMANAL · VOLTA ${weekResets}` : 'LIMITE SEMANAL'}
          value={`${Math.round(weekPct)}%`}
          percent={pct(weekPct)}
          variant={styles.fillAmber}
        />
      )}
      <Meter
        label="TOKENS DA SESSÃO"
        value={compactTokens(usage.tokensUsed)}
        percent={pct(usage.tokensUsed / 2000)}
        variant={styles.fillGreen}
      />
      <Meter
        label="CUSTO ESTIMADO"
        value={money(usage.costUsd)}
        percent={costPct}
        variant={styles.fillAmber}
      />
    </PanelBody>
  );
}

/** Painel avulso — hoje só usado se algum dia o Status voltar a ficar sozinho. */
export function StatusPanel() {
  const plan = useSession((state) => state.usage.plan);
  return (
    <Panel title="Status" badge={`plano ${plan}`} style={{ flex: '0 0 auto' }}>
      <StatusBody />
    </Panel>
  );
}

function Meter({
  label,
  value,
  percent,
  variant,
}: {
  label: string;
  value: string;
  percent: number;
  variant?: string;
}) {
  return (
    <div className={styles.meter}>
      <div className={styles.meterRow}>
        <span>{label}</span>
        <b>{value}</b>
      </div>
      <div className={styles.track}>
        <i className={[styles.fill, variant].filter(Boolean).join(' ')} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
