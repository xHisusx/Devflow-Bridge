export interface PachkaButton {
  text: string;
  url?: string;
  data?: string;
}

export interface PachkaMessage {
  id: number;
  content: string;
  entity_type: string;
  entity_id: number;
  chat_id: number;
  created_at: string;
  user_id?: number;
  buttons?: PachkaButton[][];
  thread?: { id: number; chat_id: number } | null;
  parent_message_id?: number | null;
  changed_at?: string | null;
}

export interface PachkaThread {
  id: number;
  chat_id: number;
  message_id: number;
}

export interface PachkaCustomProperty {
  id: number;
  name: string;
  data_type: string;
  value?: string | number | null;
}

export interface PachkaUser {
  id: number;
  email?: string;
  first_name?: string;
  last_name?: string;
  custom_properties?: PachkaCustomProperty[];
}
