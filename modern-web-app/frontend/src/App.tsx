import { useEffect } from 'react';
import { Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import Layout from './components/Layout';
import { RequireAdmin, RequireAuth } from './components/Guards';
import Landing from './pages/Landing';
import Stats from './pages/Stats';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import Apply from './pages/Apply';
import AppDetail from './pages/AppDetail';
import Accessibility from './pages/Accessibility';
import Certificate from './pages/Certificate';
import Letter from './pages/Letter';
import VerifyPermit from './pages/VerifyPermit';
import Admin from './pages/Admin';
import NotFound from './pages/NotFound';

/**
 * Route changes land at the top of the page, the way full page loads would.
 * Back/forward (POP) is left to the browser's own scroll restoration, and
 * hash-only changes (the landing page's #catalog anchor) never re-trigger
 * because only pathname is watched.
 */
function ScrollToTop() {
  const { pathname } = useLocation();
  const navType = useNavigationType();
  useEffect(() => {
    if (navType !== 'POP') window.scrollTo(0, 0);
  }, [pathname, navType]);
  return null;
}

export default function App() {
  return (
    <>
      <ScrollToTop />
      <Routes>
      <Route element={<Layout />}>
        <Route index element={<Landing />} />
        <Route path="stats" element={<Stats />} />
        <Route path="login" element={<Login />} />
        <Route path="register" element={<Register />} />
        <Route path="verify/:id" element={<VerifyPermit />} />
        <Route path="accessibility" element={<Accessibility />} />

        <Route element={<RequireAuth />}>
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="apply" element={<Apply />} />
          <Route path="applications/:id" element={<AppDetail />} />
        </Route>

        <Route element={<RequireAdmin />}>
          <Route path="admin" element={<Admin />} />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Route>

      {/* Printable documents render outside the app chrome so the sheet is
          the whole page. */}
      <Route element={<RequireAuth />}>
        <Route path="applications/:id/certificate" element={<Certificate />} />
        <Route path="applications/:id/letter" element={<Letter />} />
      </Route>
      </Routes>
    </>
  );
}
