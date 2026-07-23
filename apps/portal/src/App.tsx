import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import AppShell from './components/AppShell';
import { useAuth } from './lib/auth';
import Login from './pages/Login';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import InviteConsume from './pages/InviteConsume';
import Profile from './pages/Profile';
import Property from './pages/Property';
import Account from './pages/Account';
import Tickets from './pages/Tickets';
import TicketDetail from './pages/TicketDetail';
import BrokerDashboard from './pages/BrokerDashboard';
import BrokerNocs from './pages/BrokerNocs';
import BrokerStatement from './pages/BrokerStatement';

/** A broker portal session never carries applicantId and vice versa (see
 * AppShell's doc comment) — this just sends each session to its own
 * first tab, same branch AppShell uses for the tab bar itself. */
function PortalHome() {
  const { user } = useAuth();
  return <Navigate to={user?.brokerId ? '/broker/dashboard' : '/profile'} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/invite/:inviteId" element={<InviteConsume />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route index element={<PortalHome />} />
            <Route path="profile" element={<Profile />} />
            <Route path="property" element={<Property />} />
            <Route path="account" element={<Account />} />
            <Route path="tickets" element={<Tickets />} />
            <Route path="tickets/:id" element={<TicketDetail />} />
            <Route path="broker/dashboard" element={<BrokerDashboard />} />
            <Route path="broker/nocs" element={<BrokerNocs />} />
            <Route path="broker/statement" element={<BrokerStatement />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
