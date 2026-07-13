import { BookOpen, Orbit } from "lucide-react";
import { Link, Navigate, Route, Routes } from "react-router";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar.tsx";

function WorkspacePage() {
  return (
    <div data-singularity-ui className="min-h-dvh">
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarHeader className="h-10 justify-center border-b border-sidebar-border px-2 py-0">
            <div className="flex min-w-0 items-center gap-2 px-1.5 text-sm font-semibold">
              <Orbit aria-hidden="true" size={18} />
              <span className="truncate group-data-[collapsible=icon]:hidden">奇点</span>
            </div>
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>知识空间</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive tooltip="默认空间">
                      <Link to="/workspace" aria-current="page">
                        <BookOpen aria-hidden="true" />
                        <span>默认空间</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>

        <SidebarInset>
          <header className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-4" />
            <span className="truncate text-sm text-muted-foreground">默认空间</span>
          </header>

          <section className="flex min-h-0 flex-1 items-center justify-center p-6">
            <Empty>
              <EmptyHeader>
                <EmptyMedia>
                  <BookOpen aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>
                  <h1>选择一篇文档开始阅读</h1>
                </EmptyTitle>
                <EmptyDescription>文档将在这里打开。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </section>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/workspace" element={<WorkspacePage />} />
      <Route path="*" element={<Navigate replace to="/workspace" />} />
    </Routes>
  );
}
