export type AppStatus = 'submitted' | 'under_review' | 'approved' | 'denied';

export interface PermitType {
  slug: string;
  name: string;
  description: string;
  category: string;
  fee: number;
  processingDays: number;
  active?: boolean;
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
}

export interface AppEvent {
  status: AppStatus;
  at: string;
  actor: string;
  note?: string | null;
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
}

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
