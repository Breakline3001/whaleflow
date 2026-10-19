import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({base:'./',plugins:[react()],build:{outDir:'dist',emptyOutDir:true,rollupOptions:{output:{manualChunks:{react:['react','react-dom/client'],canvas:['@xyflow/react'],icons:['lucide-react']}}}}});
