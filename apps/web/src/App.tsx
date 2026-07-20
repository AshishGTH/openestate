import { BrowserRouter, Routes, Route } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import AppShell from './components/AppShell';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import UsersPage from './pages/admin/Users';
import UserForm from './pages/admin/UserForm';
import RolesPage from './pages/admin/Roles';
import RoleForm from './pages/admin/RoleForm';
import MastersPage from './pages/admin/Masters';
import CustomFieldsPage from './pages/admin/CustomFields';
import CompanyConfigPage from './pages/admin/CompanyConfig';
import AuditLogPage from './pages/admin/AuditLog';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route index element={<Dashboard />} />
            <Route path="admin/users" element={<UsersPage />} />
            <Route path="admin/users/:id" element={<UserForm />} />
            <Route path="admin/roles" element={<RolesPage />} />
            <Route path="admin/roles/:id" element={<RoleForm />} />
            <Route path="admin/masters" element={<MastersPage />} />
            <Route path="admin/custom-fields" element={<CustomFieldsPage />} />
            <Route path="admin/config" element={<CompanyConfigPage />} />
            <Route path="admin/audit" element={<AuditLogPage />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
