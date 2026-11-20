import { AppHeader } from "@/app/_components/app-header";

import { loadWorkspace } from "../_lib/load";

export default async function WorkspaceLayout({ children, params }: LayoutProps<"/w/[workspaceId]">) {
  const { workspaceId } = await params;
  const { user } = await loadWorkspace(workspaceId, `/w/${workspaceId}`);

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader email={user.email} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
