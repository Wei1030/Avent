import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppProvider } from "./store/app-context.js";
import { AppShell } from "./shell/AppShell.js";
import { HomePage } from "./pages/HomePage.js";
import { TasksListPage } from "./pages/TasksListPage.js";
import { TaskPage } from "./pages/TaskPage.js";
import { McpPage } from "./pages/McpPage.js";
import { SkillsPage } from "./pages/SkillsPage.js";
import { UsagePage } from "./pages/UsagePage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

export function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<AppShell />}>
            <Route index element={<HomePage />} />
            <Route path="tasks" element={<TasksListPage />} />
            <Route path="t/:id" element={<TaskPage />} />
            <Route path="mcp" element={<McpPage />} />
            <Route path="skills" element={<SkillsPage />} />
            <Route path="usage" element={<UsagePage />} />
            <Route path="settings/*" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AppProvider>
  );
}
