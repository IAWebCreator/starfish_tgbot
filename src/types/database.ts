export interface Activation {
    id: number;
    agent_id: number;
    transaction_id: string | null;
    verification_code: string;
    verification_used_at: Date | null;
    telegram_group_id: string | null;
    telegram_group_name: string | null;
    telegram_authorized_user: string | null;
    activation_start: Date | null;
    activation_end: Date | null;
    duration_hours: number | null;
    activation_status: 'pending' | 'active' | 'expired';
    created_at: Date;
    updated_at: Date;
} 