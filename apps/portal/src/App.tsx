import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import AppShell from './components/AppShell';
import Login from './pages/Login';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import InviteConsume from './pages/InviteConsume';
import Profile from './pages/Profile';
import Property from './pages/Property';
import Account from './pages/Account';
import Tickets from './pages/Tickets';
import TicketDetail from './pages/TicketDetail';

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
            <Route index element={<Navigate to="/profile" replace />} />
            <Route path="profile" element={<Profile />} />
            <Route path="property" element={<Property />} />
            <Route path="account" element={<Account />} />
            <Route path="tickets" element={<Tickets />} />
            <Route path="tickets/:id" element={<TicketDetail />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
