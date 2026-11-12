'use client';

// AG Studio over Cosign's own data: the dashboard the blueprint calls for (spend against the
// mandate, blocked payments, the approvals queue, escrow) plus an assistant that can answer
// "what did you block this week?" when an OpenAI key is configured on the server.

import { useMemo, useState, useSyncExternalStore } from 'react';
import { AgStudioAiModule, createAiHarness, studioTheme, type AgAiHarnessSetup, type AgDataSourcesDefinition, type AgFieldDefinition, type AgFormat, type AgPageState, type AgReportState, type AgStudioMode } from 'ag-studio';
import { AgStudio, AgStudioProvider } from 'ag-studio-react';
import { openaiAdapter } from '../../dashboard/studio/openai-adapter';

type Row = Record<string, string | number | boolean | null>;
export type StudioRows = { payments: Row[]; reasons: Row[]; milestones: Row[] };

type Spec = [id: string, name: string, format: AgFormat, hide?: boolean];
const fields = (specs: Spec[]): AgFieldDefinition[] => specs.map(([id, name, format, hide]) => ({ id, name, format, ...(hide && { hide }) }));

function sources(rows: StudioRows): AgDataSourcesDefinition {
  const dates = rows.payments.map((r) => String(r.decided).slice(0, 10)).sort();
  const today = new Date().toISOString().slice(0, 10);
  return {
    description:
      'Cosign: an AI agent reads invoices and proposes payments; a Rust policy engine decides. Paid = inside the mandate, paid automatically. Held = waiting for a human signature. Blocked = refused by a rule (changed payout details, duplicate, expired mandate); nobody can approve those. Milestones are escrow: funds are held by PayPal until released.',
    sources: [
      {
        id: 'payments',
        description: 'One row per invoice Cosign decided on. Amounts are in the invoice currency (normally USD).',
        data: rows.payments,
        fields: fields([
          ['id', 'Payment ID', 'textFormat', true],
          ['decided', 'Decided', 'dateTimeFormat'],
          ['vendor', 'Vendor', 'textFormat'],
          ['invoice', 'Invoice', 'textFormat'],
          ['amount', 'Amount', 'currencyFormat'],
          ['currency', 'Currency', 'textFormat'],
          ['decision', 'Decision', 'textFormat'],
          ['status', 'Status', 'textFormat'],
          ['paid', 'Paid', 'currencyFormat'],
          ['blocked', 'Blocked', 'currencyFormat'],
          ['waiting', 'Waiting for signature', 'currencyFormat'],
          ['approvedVendor', 'Approved vendor', 'booleanFormat'],
          ['flaggedByAgent', 'Flagged by the AI', 'booleanFormat'],
        ]),
      },
      {
        id: 'reasons',
        description: 'Why a payment was held or blocked: one row per reason. Rule = Rust policy rule; AI flag = raised by the agent (can only make decisions stricter).',
        data: rows.reasons,
        fields: fields([
          ['id', 'Reason ID', 'textFormat', true],
          ['paymentId', 'Payment ID', 'textFormat', true],
          ['reason', 'Reason', 'textFormat'],
          ['source', 'Raised by', 'textFormat'],
          ['detail', 'Detail', 'textFormat'],
        ]),
      },
      {
        id: 'milestones',
        description: 'Milestone escrow stages. Held = funds under a PayPal authorization, not yet paid to the seller.',
        data: rows.milestones,
        fields: fields([
          ['id', 'Milestone ID', 'textFormat', true],
          ['deal', 'Deal', 'textFormat'],
          ['seller', 'Seller', 'textFormat'],
          ['stage', 'Stage', 'textFormat'],
          ['amount', 'Stage amount', 'currencyFormat'],
          ['status', 'Stage status', 'textFormat'],
          ['held', 'Held in escrow', 'currencyFormat'],
          ['released', 'Released', 'currencyFormat'],
        ]),
      },
    ],
    relationships: [
      { id: 'reason-payment', source: { tableId: 'reasons', fieldId: 'paymentId' }, target: { tableId: 'payments', fieldId: 'id' }, type: 'many-to-one' },
      { id: 'payments-decided-calendar', source: { tableId: 'payments', fieldId: 'decided' }, target: { calendarId: 'calendar' }, truncate: 'day' },
    ],
    calendars: [
      {
        id: 'calendar',
        label: 'Calendar',
        range: { from: { type: 'date', value: dates[0] ?? today }, to: { type: 'date', value: dates.at(-1) ?? today } },
        fragments: ['year', 'month', 'week', 'day', 'dayOfWeek'],
      },
    ],
  };
}

const FONT = '"Public Sans Variable", "Public Sans", system-ui, sans-serif';
const t = (text: string) => ({ title: { enabled: true, text } });
const sum = (id: string) => ({ id, aggregation: 'sum' as const });
const count = (id: string) => ({ id, aggregation: 'countd' as const });
const kpi = (text: string, value: { id: string; aggregation: 'sum' | 'countd' }) => ({
  type: 'value' as const,
  dataMapping: { value: [value] },
  format: {
    title: { enabled: true, text, typography: { fontFamily: FONT, fontSize: 14, fontWeight: 'bold' as const, fontStyle: 'normal' as const } },
    style: { typography: { fontFamily: FONT, fontSize: 24, fontWeight: 'bold' as const, fontStyle: 'normal' as const } },
  },
});
const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number) => ({ xTrack, yTrack, xSpan, ySpan });

const safety: AgPageState = {
  id: 'safety',
  widgets: {
    'kpi-paid': kpi('Paid automatically', sum('payments.paid')),
    'kpi-waiting': kpi('Waiting for your signature', sum('payments.waiting')),
    'kpi-blocked': kpi('Blocked', sum('payments.blocked')),
    'kpi-invoices': kpi('Invoices decided', count('payments.id')),
    decisions: {
      type: 'donut-chart',
      dataMapping: { categoryKey: [{ id: 'payments.decision' }], valueKey: [sum('payments.amount')] },
      format: t('Invoice value by decision'),
    },
    reasons: {
      type: 'bar-chart-stacked',
      dataMapping: { categoryKey: [{ id: 'reasons.reason' }], valueKey: [count('reasons.id')], legendKey: [{ id: 'reasons.source' }] },
      format: { ...t('Why payments were stopped'), style: { theme: { common: { legend: { enabled: true } } } } },
    },
    byVendor: {
      type: 'bar-chart-grouped',
      dataMapping: { categoryKey: [{ id: 'payments.vendor' }], valueKey: [sum('payments.paid'), sum('payments.waiting'), sum('payments.blocked')] },
      format: { ...t('By vendor'), style: { theme: { common: { legend: { enabled: true } } } } },
    },
    ledger: {
      type: 'grid',
      dataMapping: { cols: [{ id: 'payments.decided' }, { id: 'payments.vendor' }, { id: 'payments.invoice' }, sum('payments.amount'), { id: 'payments.decision' }, { id: 'payments.status' }] },
      sort: [{ field: { id: 'payments.decided' }, direction: 'desc' }],
      format: t('Decisions'),
    },
  },
  widgetLayout: {
    'kpi-paid': at(0, 0, 6, 7),
    'kpi-waiting': at(6, 0, 6, 7),
    'kpi-blocked': at(12, 0, 6, 7),
    'kpi-invoices': at(18, 0, 6, 7),
    decisions: at(0, 7, 8, 18),
    reasons: at(8, 7, 16, 18),
    byVendor: at(0, 25, 10, 22),
    ledger: at(10, 25, 14, 22),
  },
};

const escrow: AgPageState = {
  id: 'escrow',
  widgets: {
    'kpi-held': kpi('Held in escrow', sum('milestones.held')),
    'kpi-released': kpi('Released to sellers', sum('milestones.released')),
    stages: {
      type: 'bar-chart-stacked',
      dataMapping: { categoryKey: [{ id: 'milestones.deal' }], valueKey: [sum('milestones.amount')], legendKey: [{ id: 'milestones.status' }] },
      format: { ...t('Deals by stage status'), style: { theme: { common: { legend: { enabled: true } } } } },
    },
    list: {
      type: 'grid',
      dataMapping: { cols: [{ id: 'milestones.deal' }, { id: 'milestones.stage' }, { id: 'milestones.status' }, sum('milestones.amount')] },
      format: t('Stages'),
    },
  },
  widgetLayout: {
    'kpi-held': at(0, 0, 12, 7),
    'kpi-released': at(12, 0, 12, 7),
    stages: at(0, 7, 12, 22),
    list: at(12, 7, 12, 22),
  },
};

const report: AgReportState = { selectedPageId: safety.id, pages: [safety, escrow] };

const theme = studioTheme.withParams({
  fontFamily: 'var(--cs-font)',
  fontSize: 14,
  textColor: 'var(--cs-ink)',
  foregroundColor: 'var(--cs-ink)',
  subtleTextColor: 'var(--cs-ink-soft)',
  backgroundColor: 'var(--cs-paper)',
  borderColor: 'var(--cs-paper-edge)',
  accentColor: 'var(--cs-sign)',
  studioWrapperBorder: false,
  studioWrapperBackgroundColor: 'var(--cs-canvas)',
  studioCanvasBorder: false,
  studioCanvasShadow: false,
  studioCanvasBackgroundColor: 'var(--cs-canvas)',
  studioWidgetBackgroundColor: 'var(--cs-paper)',
  studioWidgetBorder: { width: 1, color: 'var(--cs-paper-edge)' },
  studioWidgetBorderRadius: 12,
  studioWidgetTitleFontSize: 15,
  studioWidgetTitleFontWeight: 700,
  studioWidgetTitleTextColor: 'var(--cs-ink)',
  chartFontFamily: 'var(--cs-font)',
  chartTextColor: 'var(--cs-ink)',
  // Neutral series colours: Studio orders categories itself, so stamp colours would mislabel them.
  chartPaletteFills1Color: 'var(--cs-sign)',
  chartPaletteStrokes1Color: 'var(--cs-sign)',
  chartPaletteFills2Color: 'var(--cs-ink)',
  chartPaletteStrokes2Color: 'var(--cs-ink)',
  chartPaletteFills3Color: '#7f95e8',
  chartPaletteStrokes3Color: '#7f95e8',
  chartPaletteFills4Color: 'var(--cs-ink-faint)',
  chartPaletteStrokes4Color: 'var(--cs-ink-faint)',
  chartPaletteFills5Color: '#b9c6f2',
  chartPaletteStrokes5Color: '#b9c6f2',
});

function ai(models: string[]): AgAiHarnessSetup {
  const adapter = openaiAdapter({ endpoint: '/api/ai', model: models[0] });
  return ({ api }) =>
    createAiHarness(api, {
      adapter,
      promptStarters: [
        { label: 'What did you block this week?', prompt: 'What did Cosign block this week, and why? List each payment with its reasons.' },
        { label: 'Waiting for me', prompt: 'Which payments are waiting for my signature, largest first?' },
        { label: 'Escrow', prompt: 'How much money is held in milestone escrow, by deal?' },
      ],
      models: models.length > 1 ? models.map((id) => ({ id, label: id })) : undefined,
    });
}

const noSub = () => () => {};

export function CosignStudio({ rows, licenseKey, aiModels }: { rows: StudioRows; licenseKey?: string; aiModels?: string[] }) {
  const inBrowser = useSyncExternalStore(noSub, () => true, () => false);
  const [mode, setMode] = useState<AgStudioMode>('view');
  const data = useMemo(() => sources(rows), [rows]);
  const harness = useMemo(() => (aiModels ? ai(aiModels) : undefined), [aiModels]);
  if (!inBrowser) return <div className="cs-card h-full animate-pulse" />;
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex gap-2">
        {(['view', 'edit'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            aria-pressed={mode === m}
            className={`h-9 rounded-lg px-4 text-sm font-semibold ${mode === m ? 'bg-cs-sign text-cs-on-accent' : 'border border-cs-edge bg-cs-paper text-cs-ink hover:bg-cs-hover'}`}
          >
            {m === 'view' ? 'View' : 'Edit'}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <AgStudioProvider licenseKey={licenseKey} modules={harness ? [AgStudioAiModule] : undefined}>
          <AgStudio style={{ height: '100%', width: '100%' }} theme={theme} layout={{ widgetBorderEnabled: true }} data={data} ai={harness} initialState={report} mode={mode} />
        </AgStudioProvider>
      </div>
    </div>
  );
}
