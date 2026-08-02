import { BrowserRouter, Routes, Route } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import AppShell from './components/AppShell';
import Login from './pages/Login';
import ResetPassword from './pages/ResetPassword';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import UsersPage from './pages/admin/Users';
import UserForm from './pages/admin/UserForm';
import RolesPage from './pages/admin/Roles';
import RoleForm from './pages/admin/RoleForm';
import MastersPage from './pages/admin/Masters';
import CustomFieldsPage from './pages/admin/CustomFields';
import CompanyConfigPage from './pages/admin/CompanyConfig';
import AuditLogPage from './pages/admin/AuditLog';
import BookingWizard from './pages/postsales/BookingWizard';
import InstallmentSchedule from './pages/postsales/InstallmentSchedule';
import ReceiptEntry from './pages/postsales/ReceiptEntry';
import ChequeQueue from './pages/postsales/ChequeQueue';
import DuesDashboard from './pages/postsales/DuesDashboard';
import Applicant360 from './pages/postsales/Applicant360';
import ReportsPage from './pages/postsales/Reports';
import BrokersPage from './pages/postsales/Brokers';
import BrokerDetail from './pages/postsales/BrokerDetail';
import PluginsPage from './pages/admin/Plugins';
import PluginDetailPage from './pages/admin/PluginDetail';
import WebhooksPage from './pages/admin/Webhooks';
import LeadApiKeysPage from './pages/admin/LeadApiKeys';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/reset-password" element={<ResetPassword />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route index element={<Dashboard />} />
            <Route path="settings" element={<Settings />} />
            <Route path="admin/users" element={<UsersPage />} />
            <Route path="admin/users/:id" element={<UserForm />} />
            <Route path="admin/roles" element={<RolesPage />} />
            <Route path="admin/roles/:id" element={<RoleForm />} />
            <Route path="admin/masters" element={<MastersPage />} />
            <Route path="admin/custom-fields" element={<CustomFieldsPage />} />
            <Route path="admin/config" element={<CompanyConfigPage />} />
            <Route path="admin/audit" element={<AuditLogPage />} />
            <Route path="admin/plugins" element={<PluginsPage />} />
            <Route path="admin/plugins/:pluginId" element={<PluginDetailPage />} />
            <Route path="admin/webhooks" element={<WebhooksPage />} />
            <Route path="admin/lead-api-keys" element={<LeadApiKeysPage />} />

            <Route path="postsales/bookings/new" element={<BookingWizard />} />
            <Route path="postsales/bookings/:bookingId/installments" element={<InstallmentSchedule />} />
            <Route path="postsales/receipts/new" element={<ReceiptEntry />} />
            <Route path="postsales/cheques" element={<ChequeQueue />} />
            <Route path="postsales/dues" element={<DuesDashboard />} />
            <Route path="postsales/applicants/:applicantId" element={<Applicant360 />} />
            <Route path="postsales/reports" element={<ReportsPage />} />
            <Route path="postsales/brokers" element={<BrokersPage />} />
            <Route path="postsales/brokers/:brokerId" element={<BrokerDetail />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
