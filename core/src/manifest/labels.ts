export const LABELS = [
  'ai::todo',
  'ai::in-spec',
  'ai::spec-ready',
  'ai::in-dev',
  'ai::in-review',
  'ai::done',
  'ai::blocked',
] as const;

export type Label = (typeof LABELS)[number];

export type LabelEvent =
  | 'spec-start'
  | 'spec-ready'
  | 'approve'
  | 'review-start'
  | 'review-pass'
  | 'block'
  | 'unblock'
  | 'reopen';

export const LABEL_EVENTS: LabelEvent[] = [
  'spec-start',
  'spec-ready',
  'approve',
  'review-start',
  'review-pass',
  'block',
  'unblock',
  'reopen',
];

const TRANSITIONS: Record<Label, Partial<Record<LabelEvent, Label>>> = {
  'ai::todo': { 'spec-start': 'ai::in-spec', block: 'ai::blocked' },
  'ai::in-spec': { 'spec-ready': 'ai::spec-ready', block: 'ai::blocked' },
  'ai::spec-ready': { approve: 'ai::in-dev', block: 'ai::blocked' },
  'ai::in-dev': { 'review-start': 'ai::in-review', block: 'ai::blocked' },
  'ai::in-review': {
    'review-pass': 'ai::done',
    block: 'ai::blocked',
  },
  'ai::done': { reopen: 'ai::todo' },
  'ai::blocked': { unblock: 'ai::todo', reopen: 'ai::todo' },
};

export class LabelTransitionError extends Error {
  constructor(
    readonly from: Label,
    readonly event: LabelEvent,
    readonly allowed: LabelEvent[],
  ) {
    super(
      `transición no permitida: ${from} + ${event}. Eventos válidos: ${allowed.join(', ') || 'ninguno'}`,
    );
    this.name = 'LabelTransitionError';
  }
}

export function isLabel(value: string): value is Label {
  return (LABELS as readonly string[]).includes(value);
}

export function allowedEvents(from: Label): LabelEvent[] {
  return Object.keys(TRANSITIONS[from]) as LabelEvent[];
}

export function advanceLabel(from: Label, event: LabelEvent): Label {
  const next = TRANSITIONS[from][event];
  if (!next) {
    throw new LabelTransitionError(from, event, allowedEvents(from));
  }
  return next;
}

export function dryRunLane(start: Label, events: LabelEvent[]): Label[] {
  const path: Label[] = [start];
  let current = start;
  for (const event of events) {
    current = advanceLabel(current, event);
    path.push(current);
  }
  return path;
}

export function assertHumanGate(from: Label, event: LabelEvent): void {
  if (event === 'approve' && from !== 'ai::spec-ready') {
    throw new LabelTransitionError(from, event, allowedEvents(from));
  }
}
