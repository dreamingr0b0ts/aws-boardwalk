import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './lib/auth';
import { ThemeProvider } from './lib/theme';
import { loadConfig } from './config';
import '@fontsource-variable/fraunces';
import '@fontsource-variable/fraunces/wght-italic.css';
import './index.css';

const root = createRoot(document.getElementById('root')!);

loadConfig()
  .then(() => {
    root.render(
      <StrictMode>
        <BrowserRouter>
          <ThemeProvider>
            <AuthProvider>
              <App />
            </AuthProvider>
          </ThemeProvider>
        </BrowserRouter>
      </StrictMode>
    );
  })
  .catch((err: Error) => {
    root.render(
      <div style={{ fontFamily: 'ui-sans-serif, system-ui', padding: '4rem 2rem', maxWidth: 560, margin: '0 auto' }}>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Alpenglow Permits — configuration missing</h1>
        <p style={{ marginTop: '1rem', color: '#555' }}>{err.message}</p>
      </div>
    );
  });
