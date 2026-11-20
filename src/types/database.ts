/**
 * Database types for the Supabase client, matching supabase/migrations.
 * Once a Supabase project is linked, this file can be regenerated with:
 *   npx supabase gen types typescript --project-id <ref> --schema public > src/types/database.ts
 */

export type WorkspaceRole = "owner" | "admin" | "member";

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
    };
    Enums: {
      workspace_role: WorkspaceRole;
    };
    CompositeTypes: { [_ in never]: never };
  };
};
