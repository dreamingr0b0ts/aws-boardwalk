export type AppStatus = 'submitted' | 'under_review' | 'approved' | 'denied';
export type InspectionState = 'required' | 'scheduled' | 'passed' | 'failed';
export type EventTone = 'ok' | 'warn' | 'bad';

export interface PermitType {
  slug: string;
  name: string;
  description: string;
  category: string;
  fee: number;
  processingDays: number;
  active?: boolean;
  requiresInspection?: boolean;
}

export interface Application {
  id: string;
  typeSlug: string;
  typeName: string;
  category: string;
  applicantName: string;
  applicantEmail: string;
  address: string;
  description: string;
  status: AppStatus;
  submittedAt: string;
  decidedAt?: string;
  decisionNote?: string;
  inspection?: InspectionState;
  closedAt?: string;
}

export interface Inspection {
  n: number;
  result: 'scheduled' | 'passed' | 'failed';
  scheduledFor: string;
  scheduledAt: string;
  scheduledBy: string;
  inspector?: string;
  recordedAt?: string;
  note?: string | null;
}

export interface AppEvent {
  status: AppStatus;
  at: string;
  actor: string;
  note?: string | null;
  /** Optional override for non-status events (documents, inspections). */
  title?: string;
  tone?: EventTone;
}

export interface Attachment {
  attId: string;
  filename: string;
  contentType: string;
  size?: number;
  uploadedAt?: string;
  downloadUrl: string;
}

export interface AppNotification {
  appId: string;
  typeName: string;
  status: AppStatus;
  note?: string | null;
  at: string;
  title?: string;
  tone?: EventTone;
}

export interface VerifyRecord {
  id: string;
  typeName: string;
  category: string;
  address: string;
  holder: string;
  status: AppStatus;
  submittedAt: string;
  decidedAt?: string | null;
  inspection?: InspectionState | null;
  closedAt?: string | null;
}

export const INSPECTION_LABEL: Record<InspectionState, string> = {
  required: 'Inspection due',
  scheduled: 'Inspection scheduled',
  passed: 'Finaled',
  failed: 'Reinspection required',
};

export interface CurrentStats {
  counts: Record<AppStatus, number>;
  total: number;
  avgProcessingDays: number;
  updatedAt: string;
}

export interface MonthStats {
  month: string;
  received: number;
  approved: number;
  denied: number;
  avgProcessingDays: number;
  byType: Record<string, number>;
}

export interface StatsResponse {
  current: CurrentStats | null;
  monthly: MonthStats[];
}

export interface MetricsResponse extends StatsResponse {
  oldestPendingDays: number;
}

export const STATUS_LABEL: Record<AppStatus, string> = {
  submitted: 'Submitted',
  under_review: 'Under review',
  approved: 'Approved',
  denied: 'Denied',
};
