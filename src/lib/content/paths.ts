/**
 * URL paths of the content pages (built in M2 step 4). Shared by Server Actions
 * (for revalidatePath) and the UI. Ids must already be validated UUIDs.
 */
export const contentPaths = {
  workspace: (workspaceId: string) => `/w/${workspaceId}`,
  project: (workspaceId: string, projectId: string) => `/w/${workspaceId}/p/${projectId}`,
  post: (workspaceId: string, postId: string) => `/w/${workspaceId}/posts/${postId}`,
};
