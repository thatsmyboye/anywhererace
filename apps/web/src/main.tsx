import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { UnitsProvider } from '@anywhererace/ui';
import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('No #root element to mount into.');

// Units wrap the whole app rather than each screen: the choice is one the
// reader makes once, and a track list in kilometers leading to a race view in
// miles would be nobody's idea of a preference.
createRoot(container).render(
  <StrictMode>
    <UnitsProvider>
      <App />
    </UnitsProvider>
  </StrictMode>,
);
