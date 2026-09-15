import { defineConfig } from 'vite';

// GitHub Pages(프로젝트 페이지)는 /<repo>/ 하위에 배포되므로 상대 경로를 쓴다.
export default defineConfig({
  base: './',
  build: { target: 'es2022', outDir: 'dist' },
});
