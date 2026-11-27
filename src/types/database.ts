/**
 * Database types for the Supabase client, matching supabase/migrations.
 * Once a Supabase project is linked, this file can be regenerated with:
 *   npx supabase gen types typescript --project-id <ref> --schema public > src/types/database.ts
 */

export type WorkspaceRole = "owner" | "admin" | "member";

/** `published` is set only by approve_publish_request() (M4 human approval). */
export type ContentPostStatus = "draft" | "ready" | "published";

export type ContentChangeSource = "user" | "agent";

export type AgentActionKind = "read" | "create" | "update" | "publish_request" | "unknown";
export type AgentActionStatus = "success" | "error" | "skipped";
export type AgentActionField = "title" | "body" | "scheduled_for";

export type PublishRequestStatus = "pending" | "approved" | "rejected" | "cancelled";
export type PublishRequestCancelReason = "withdrawn" | "post_changed" | "expired";
export type PublishRequestEvent = "requested" | "approved" | "rejected" | "cancelled" | "published";

export type PublishingDestinationKind = "internal" | "telegram" | "discord" | "facebook";
export type PublishingDestinationStatus = "active" | "disabled";
export type PublishDeliveryStatus = "queued" | "sending" | "succeeded" | "failed" | "cancelled";

export type PublishingDestinationRow = {
  id: string;
  workspace_id: string;
  kind: PublishingDestinationKind;
  name: string;
  target_ref: string | null;
  status: PublishingDestinationStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type PublishDeliveryRow = {
  id: string;
  workspace_id: string;
  request_id: string;
  destination_id: string;
  post_id: string;
  post_version: number;
  status: PublishDeliveryStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  external_post_id: string | null;
  last_error_code: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type ContentPublishRequestRow = {
  id: string;
  workspace_id: string;
  post_id: string;
  /** M4.6a: the one destination this request (and its approval) is for. */
  destination_id: string;
  post_version: number;
  status: PublishRequestStatus;
  request_source: ContentChangeSource;
  agent_turn_id: string | null;
  reason: string | null;
  requested_by: string | null;
  requested_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  cancel_reason: PublishRequestCancelReason | null;
};

export type ContentPostRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  title: string;
  body: string;
  status: ContentPostStatus;
  scheduled_for: string | null;
  published_at: string | null;
  version: number;
  last_change_source: ContentChangeSource;
  created_by: string | null;
  updated_by: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      workspaces: {
        Row: {
          id: string;
          name: string;
          created_by: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          created_by?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          name?: string;
        };
        Relationships: [];
      };
      workspace_members: {
        Row: {
          workspace_id: string;
          user_id: string;
          role: WorkspaceRole;
          created_at: string;
        };
        Insert: {
          workspace_id: string;
          user_id: string;
          role?: WorkspaceRole;
          created_at?: string;
        };
        Update: {
          role?: WorkspaceRole;
        };
        Relationships: [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      sports_news_revision_photos: {
        Row: {
          post_id: string;
          post_version: number;
          image_base64: string;
          source_url: string;
          license: string;
          author: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      sports_news_items: {
        Row: {
          workspace_id: string;
          project_id: string;
          source_url: string;
          headline_key: string;
          score: number;
          post_id: string | null;
          image_base64: string | null;
          has_image: boolean;
          assessment: Json | null;
          review_notice_sent_at: string | null;
          review_notice_claim: string | null;
          review_notice_claimed_at: string | null;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      content_projects: {
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          description: string | null;
          created_by: string | null;
          archived_at: string | null;
          created_at: string;
          updated_at: string;
        };
        // Only these columns are granted to `authenticated` for INSERT.
        Insert: {
          id?: string;
          workspace_id: string;
          name: string;
          description?: string | null;
        };
        // Only these columns are granted for UPDATE (owners/admins via RLS).
        Update: {
          name?: string;
          description?: string | null;
          archived_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "content_projects_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      content_posts: {
        Row: ContentPostRow;
        // Only these columns are granted to `authenticated` for INSERT.
        Insert: {
          id?: string;
          workspace_id: string;
          project_id: string;
          title: string;
          body?: string;
          status?: Exclude<ContentPostStatus, "published">;
          scheduled_for?: string | null;
          last_change_source?: ContentChangeSource;
        };
        // No UPDATE privilege: use the update/archive/restore RPCs.
        Update: { [_ in never]: never };
        Relationships: [
          {
            foreignKeyName: "content_posts_project_fkey";
            columns: ["workspace_id", "project_id"];
            isOneToOne: false;
            referencedRelation: "content_projects";
            referencedColumns: ["workspace_id", "id"];
          },
        ];
      };
      content_post_versions: {
        Row: {
          id: string;
          workspace_id: string;
          post_id: string;
          version: number;
          title: string;
          body: string;
          status: ContentPostStatus;
          scheduled_for: string | null;
          archived_at: string | null;
          changed_by: string | null;
          change_source: ContentChangeSource;
          created_at: string;
        };
        // Append-only, written by a database trigger.
        Insert: { [_ in never]: never };
        Update: { [_ in never]: never };
        Relationships: [
          {
            foreignKeyName: "content_post_versions_post_fkey";
            columns: ["workspace_id", "post_id"];
            isOneToOne: false;
            referencedRelation: "content_posts";
            referencedColumns: ["workspace_id", "id"];
          },
        ];
      };
      agent_actions: {
        Row: {
          id: string;
          workspace_id: string;
          user_id: string | null;
          turn_id: string;
          tool: string;
          kind: AgentActionKind;
          status: AgentActionStatus;
          error_code: string | null;
          project_id: string | null;
          post_id: string | null;
          version_before: number | null;
          version_after: number | null;
          fields: AgentActionField[] | null;
          /** M4.6c: the publish request a publish_request row describes. */
          request_id: string | null;
          created_at: string;
        };
        // Only these columns are granted for INSERT; user_id and created_at are set by the database.
        Insert: {
          workspace_id: string;
          turn_id: string;
          tool: string;
          kind: AgentActionKind;
          status: AgentActionStatus;
          error_code?: string | null;
          project_id?: string | null;
          post_id?: string | null;
          version_before?: number | null;
          version_after?: number | null;
          fields?: AgentActionField[] | null;
          request_id?: string | null;
        };
        // Append-only.
        Update: { [_ in never]: never };
        Relationships: [
          {
            foreignKeyName: "agent_actions_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      publishing_destinations: {
        Row: PublishingDestinationRow;
        // Owners/admins (RLS); only these columns are granted.
        Insert: { workspace_id: string; kind: PublishingDestinationKind; name: string; target_ref?: string | null };
        Update: { name?: string; status?: PublishingDestinationStatus; target_ref?: string | null };
        Relationships: [
          {
            foreignKeyName: "publishing_destinations_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      publish_deliveries: {
        Row: PublishDeliveryRow;
        // Written only by approve_publish_request (and, in M5, a server-side worker).
        Insert: { [_ in never]: never };
        Update: { [_ in never]: never };
        Relationships: [
          {
            foreignKeyName: "publish_deliveries_request_fkey";
            columns: ["workspace_id", "request_id"];
            isOneToOne: true;
            referencedRelation: "content_publish_requests";
            referencedColumns: ["workspace_id", "id"];
          },
        ];
      };
      user_profiles: {
        Row: { user_id: string; display_name: string; created_at: string; updated_at: string };
        // Only display_name is granted; user_id is set from auth.uid() by a trigger.
        Insert: { display_name: string };
        Update: { display_name?: string };
        Relationships: [];
      };
      content_publish_requests: {
        Row: ContentPublishRequestRow;
        // Written only by the publish RPCs.
        Insert: { [_ in never]: never };
        Update: { [_ in never]: never };
        Relationships: [
          {
            foreignKeyName: "content_publish_requests_post_fkey";
            columns: ["workspace_id", "post_id"];
            isOneToOne: false;
            referencedRelation: "content_posts";
            referencedColumns: ["workspace_id", "id"];
          },
        ];
      };
      content_publish_request_events: {
        Row: {
          id: string;
          workspace_id: string;
          request_id: string;
          post_id: string;
          post_version: number;
          event: PublishRequestEvent;
          cancel_reason: PublishRequestCancelReason | null;
          actor_id: string | null;
          actor_source: ContentChangeSource | null;
          created_at: string;
        };
        // Append-only, written by database triggers and approve_publish_request().
        Insert: { [_ in never]: never };
        Update: { [_ in never]: never };
        Relationships: [
          {
            foreignKeyName: "content_publish_request_events_request_fkey";
            columns: ["workspace_id", "request_id"];
            isOneToOne: false;
            referencedRelation: "content_publish_requests";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "content_publish_request_events_post_fkey";
            columns: ["workspace_id", "post_id"];
            isOneToOne: false;
            referencedRelation: "content_posts";
            referencedColumns: ["workspace_id", "id"];
          },
        ];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      read_sports_auto_publish_control: {
        Args: { p_workspace_id: string; p_project_id: string; p_destination_id: string };
        Returns: { id: string; starts_at: string; ends_at: string; max_per_slot: number; max_per_window: number }[];
      };
      set_sports_auto_publish_control: {
        Args: { p_workspace_id: string; p_project_id: string; p_destination_id: string; p_enabled: boolean; p_hours: number; p_slot_limit: number; p_window_limit: number };
        Returns: boolean;
      };
      get_sports_auto_publish_window: {
        Args: { p_workspace_id: string; p_project_id: string; p_destination_id: string };
        Returns: { id: string; starts_at: string; ends_at: string }[];
      };
      claim_sports_auto_publish: {
        Args: { p_workspace_id: string; p_project_id: string; p_destination_id: string; p_post_id: string };
        Returns: { id: string; starts_at: string; ends_at: string; target_ref: string; created_at: string }[];
      };
      finish_sports_auto_publish: {
        Args: { p_workspace_id: string; p_id: string; p_external_id: string | null; p_error_code: string | null };
        Returns: boolean;
      };
      record_sports_news_assessment: {
        Args: Database["public"]["Functions"]["record_sports_news"]["Args"] & { p_assessment: Json };
        Returns: string | null;
      };
      record_sports_news: {
        Args: {
          p_workspace_id: string;
          p_project_id: string;
          p_source_url: string;
          p_headline_key: string;
          p_score: number;
          p_title: string | null;
          p_body: string | null;
          p_image: string | null;
          p_reason: string | null;
          p_destinations: string[];
        };
        Returns: string | null;
      };
      claim_sports_news_review_notices: {
        Args: { p_workspace_id: string; p_project_id: string };
        Returns: Array<{ post_id: string; claim_id: string; title: string; score: number; request_ids: string[] }>;
      };
      finish_sports_news_review_notice: {
        Args: { p_workspace_id: string; p_post_id: string; p_claim_id: string; p_sent: boolean };
        Returns: boolean;
      };
      claim_social_deliveries: {
        Args: { p_workspace_id: string; p_destinations: string[] };
        Returns: Array<{
          id: string;
          destination_id: string;
          kind: string;
          target_ref: string;
          idempotency_key: string;
          post_id: string;
          post_version: number;
          title: string;
          body: string;
        }>;
      };
      finish_social_delivery: {
        Args: {
          p_workspace_id: string;
          p_id: string;
          p_external_id: string | null;
          p_error_code: string | null;
        };
        Returns: boolean;
      };
      health_check: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      is_workspace_member: {
        Args: { p_workspace_id: string };
        Returns: boolean;
      };
      has_workspace_role: {
        Args: { p_workspace_id: string; p_roles: WorkspaceRole[] };
        Returns: boolean;
      };
      update_content_post: {
        Args: {
          p_post_id: string;
          p_expected_version: number;
          p_title: string;
          p_body: string;
          p_status: Exclude<ContentPostStatus, "published">;
          p_scheduled_for: string | null;
          p_change_source?: ContentChangeSource;
        };
        Returns: ContentPostRow;
      };
      archive_content_post: {
        Args: { p_post_id: string; p_expected_version: number; p_change_source?: ContentChangeSource };
        Returns: ContentPostRow;
      };
      restore_content_post: {
        Args: { p_post_id: string; p_expected_version: number; p_change_source?: ContentChangeSource };
        Returns: ContentPostRow;
      };
      request_post_publish: {
        Args: {
          p_post_id: string;
          p_expected_version: number;
          p_source?: ContentChangeSource;
          p_agent_turn_id?: string | null;
          p_reason?: string | null;
          /** M4.6a. Omitted (legacy user calls): the workspace's internal destination. Required for agent requests. */
          p_destination_id?: string | null;
        };
        Returns: ContentPublishRequestRow;
      };
      approve_publish_request: {
        /** p_expected_destination_id (M4.6a): when given, must equal the request's destination. */
        Args: { p_request_id: string; p_expected_post_version: number; p_expected_destination_id?: string | null };
        Returns: ContentPostRow;
      };
      reject_publish_request: {
        Args: { p_request_id: string; p_note?: string | null };
        Returns: ContentPublishRequestRow;
      };
      shares_workspace_with: {
        Args: { p_user_id: string };
        Returns: boolean;
      };
      cancel_publish_request: {
        Args: { p_request_id: string };
        Returns: ContentPublishRequestRow;
      };
    };
    Enums: {
      workspace_role: WorkspaceRole;
      content_post_status: ContentPostStatus;
      content_change_source: ContentChangeSource;
      publish_request_status: PublishRequestStatus;
      publish_request_cancel_reason: PublishRequestCancelReason;
      publish_request_event: PublishRequestEvent;
    };
    CompositeTypes: { [_ in never]: never };
  };
};
