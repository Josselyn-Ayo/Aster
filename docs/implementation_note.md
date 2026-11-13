# Implementación de "se detuvo la tarea"

Se modificó el método `cancelTask()` en `src/controllers/AsterController.ts:726` para mostrar el mensaje "se detuvo la tarea" en lugar de "Tarea cancelada. No se ejecutó ninguna acción." cuando el usuario detiene una tarea en curso.

**Cambio realizado:**
- Linea 726: `const text = "se detuvo la tarea";` (antes era `"Tarea cancelada. No se ejecutó ninguna acción."`)

**Verificación:**
- `npm test`: 117 pruebas pasan
- `npm run build`: compilación TypeScript y Vite completan exitosamente