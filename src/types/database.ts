/**
 * Database types for the Supabase client, matching supabase/migrations.
 * Once a Supabase project is linked, this file can be regenerated with:
 *   npx supabase gen types typescript --project-id <ref> --schema public > src/types/database.ts
 */

export type WorkspaceRole = "owner" | "admin" | "member";

/** `published` exists in the enum but is rejected by the database until M4. */
export type ContentPostStatus = "draft" | "ready" | "published";

export type ContentChangeSource = "user" | "agent";

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
    };
    Views: { [_ in never]: never };
    Functions: {
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
    };
    Enums: {
      workspace_role: WorkspaceRole;
      content_post_status: ContentPostStatus;
      content_change_source: ContentChangeSource;
    };
    CompositeTypes: { [_ in never]: never };
  };
};
