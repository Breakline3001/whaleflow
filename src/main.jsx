import React from 'react';
import {createRoot} from 'react-dom/client';
import {ReactFlowProvider} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import App from './App.jsx';
import './styles.css';
import './libtv-alignment.css';
createRoot(document.getElementById('root')).render(<ReactFlowProvider><App/></ReactFlowProvider>);
