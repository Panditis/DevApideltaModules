// Theme compartido Apidelta (Fluent 2 + paleta propia). Cargar después del CDN de
// Tailwind y antes de cualquier <style>/clase que dependa de estos tokens.
// Nombres de color pensados para no romper el HTML de los módulos ya migrados:
// mismos nombres que usaba insumos.html (verde/verdeHover/amarillo/bg/card/borde/ink/ok/gris),
// + warn/crit nuevos para reemplazar los viejos rojo/naranja/ambar.
tailwind.config = { theme: { extend: {
  colors: {
    verde: '#405936', verdeHover: '#4f6e42', amarillo: '#FFCC00',
    bg: '#eef1ea', card: '#ffffff', borde: 'rgba(26,28,24,.16)', ink: '#242423',
    ok: '#0e700e', warn: '#8a5d00', crit: '#a4262c', gris: '#5c5f52',
  },
  fontFamily: {
    disp: ['system-ui', '"Segoe UI"', 'sans-serif'],
    body: ['system-ui', '"Segoe UI"', 'sans-serif'],
  },
  boxShadow: {
    fluent: '0 1.6px 3.6px rgba(26,28,24,.13), 0 0.3px 0.9px rgba(26,28,24,.1)',
  },
} } };
