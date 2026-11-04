export type ContractStatus =
  | "NEGOTIATING"
  | "ACTIVE"
  | "DISPUTED"
  | "COMPLETED";

export type MilestoneStatus =
  | "AWAITING_FUNDS"
  | "ESCROWED"
  | "PENDING_RELEASE"
  | "PAID"
  | "MUTED_DISPUTE";

export type VerificationType = "github_commit" | "figma_link";

export type PayoutStatus = "PROCESSING" | "SUCCEEDED" | "FAILED";

export interface Contract {
  id: string;
  source_fingerprint: string;
  freelancer_email: string;
  freelancer_email_verified: boolean;
  client_email: string;
  client_email_verified: boolean;
  total_budget: number;
  currency: string;
  current_status: ContractStatus;
  paypal_order_id: string | null;
  paypal_approval_url: string | null;
  paypal_authorization_id: string | null;
  paypal_capture_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PayPalCaptureResponse {
  id: string;
  status: string;
  amount: {
    currency_code: string;
    value: string;
  };
  final_capture?: boolean;
}

export interface Milestone {
  id: string;
  contract_id: string;
  title: string;
  amount: number;
  verification_type: VerificationType;
  description: string;
  status: MilestoneStatus;
  ai_score: number | null;
  ai_summary: string | null;
  ai_evidence: Json;
  verification_commit_sha: string | null;
  verification_timestamp: string | null;
  release_countdown_eta: string | null;
  released_amount: number;
  paypal_payout_batch_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MilestonePayout {
  id: string;
  milestone_id: string;
  amount: number;
  currency: string;
  status: PayoutStatus;
  idempotency_key: string;
  paypal_batch_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContractParseMilestone {
  title: string;
  amount: number;
  verification_type: VerificationType;
  description: string;
}

export interface ContractParseOutput {
  freelancer_email: string;
  client_email: string;
  total_budget: number;
  currency: string;
  milestones: ContractParseMilestone[];
}

export interface WorkVerificationInput {
  milestoneId: string;
  repository: string;
  commitHash: string;
}

export interface WorkVerificationResult {
  score: number;
  summary: string;
  evidence: string[];
}

export interface WorkVerificationResponse extends WorkVerificationResult {
  milestone: Milestone;
}

export interface MilestoneGridRow {
  id: string;
  contractId: string;
  title: string;
  amount: number;
  currency: string;
  status: MilestoneStatus;
  score: number | null;
  verificationType: VerificationType;
  commitHash: string | null;
  verificationTimestamp: string | null;
  releaseCountdownEta: string | null;
  releasedAmount: number;
  canAuthorize: boolean;
  canRelease: boolean;
  isSimulated?: boolean;
}

export interface PayPalOAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

export interface PayPalOrderResponse {
  id: string;
  status: string;
  intent: "AUTHORIZE";
  links: PayPalLink[];
}

export interface PayPalAuthorization {
  id: string;
  status: string;
  amount: {
    currency_code: string;
    value: string;
  };
}

export interface PayPalAuthorizationResponse {
  id: string;
  status: string;
  purchase_units: Array<{
    payments?: {
      authorizations?: PayPalAuthorization[];
    };
  }>;
}

export interface PayPalPayoutItem {
  payout_item_id: string;
  transaction_status: string;
  payout_item?: {
    recipient_type: "EMAIL";
    amount: {
      value: string;
      currency: string;
    };
    receiver: string;
  };
  errors?: {
    name: string;
    message: string;
  };
}

export interface PayPalPayoutResponse {
  batch_header: {
    payout_batch_id: string;
    batch_status: string;
  };
  links?: PayPalLink[];
}

export interface PayPalErrorResponse {
  name?: string;
  message?: string;
  details?: Array<{
    issue?: string;
    description?: string;
  }>;
  debug_id?: string;
}

export interface PayoutReservation {
  payout_id: string;
  milestone_id: string;
  currency: string;
  idempotency_key: string;
  is_retry: boolean;
}

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      contracts: {
        Row: Contract & Record<string, unknown>;
        Insert: Omit<Contract, "id" | "created_at" | "updated_at"> &
          Partial<Pick<Contract, "id" | "created_at" | "updated_at">> &
          Record<string, unknown>;
        Update: Partial<Contract> & Record<string, unknown>;
        Relationships: [];
      };
      milestones: {
        Row: Milestone & Record<string, unknown>;
        Insert: Omit<Milestone, "id" | "created_at" | "updated_at"> &
          Partial<Pick<Milestone, "id" | "created_at" | "updated_at">> &
          Record<string, unknown>;
        Update: Partial<Milestone> & Record<string, unknown>;
        Relationships: [];
      };
      milestone_payouts: {
        Row: MilestonePayout & Record<string, unknown>;
        Insert: Omit<MilestonePayout, "id" | "created_at" | "updated_at"> &
          Partial<Pick<MilestonePayout, "id" | "created_at" | "updated_at">> &
          Record<string, unknown>;
        Update: Partial<MilestonePayout> & Record<string, unknown>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      upsert_contract_from_negotiation: {
        Args: { p_fingerprint: string; p_payload: Json };
        Returns: string;
      };
      activate_contract_after_authorization: {
        Args: {
          p_contract_id: string;
          p_order_id: string;
          p_authorization_id: string;
          p_capture_id: string;
          p_authorized_amount: number;
          p_currency: string;
          p_client_email: string;
        };
        Returns: string;
      };
      record_pending_escrow_capture: {
        Args: {
          p_contract_id: string;
          p_order_id: string;
          p_authorization_id: string;
          p_capture_id: string;
          p_client_email: string;
        };
        Returns: undefined;
      };
      fail_pending_escrow_capture: {
        Args: { p_capture_id: string } & Record<string, unknown>;
        Returns: undefined;
      };
      raise_milestone_dispute: {
        Args: { p_milestone_id: string; p_user_email: string } & Record<
          string,
          unknown
        >;
        Returns: Milestone & Record<string, unknown>;
      };
      record_work_verification: {
        Args: {
          p_milestone_id: string;
          p_ai_score: number;
          p_commit_sha: string;
          p_summary: string;
          p_evidence: Json;
        };
        Returns: Milestone & Record<string, unknown>;
      };
      reserve_milestone_payout: {
        Args: {
          p_freelancer_email: string;
          p_amount: number;
          p_idempotency_key: string;
          p_milestone_id: string | null;
        };
        Returns: PayoutReservation[];
      };
      complete_milestone_payout: {
        Args: { p_payout_id: string; p_paypal_batch_id: string };
        Returns: undefined;
      };
      fail_milestone_payout: {
        Args: { p_payout_id: string; p_error_message: string };
        Returns: undefined;
      };
      verify_contract_party: {
        Args: { p_email: string } & Record<string, unknown>;
        Returns: number;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
}
