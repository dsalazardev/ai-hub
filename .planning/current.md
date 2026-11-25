# Estado de la sesión — `harden-harness-orchestration` — cierre técnico 2026-11-24 (d)

- **Rama:** `codex/harden-harness-orchestration`. Candidato de release `dd6df0e` (0.18.0, sin publicar). Sin merge ni force-push.
- **Progreso:** 160/176; las 16 abiertas tienen disposición registrada en `decisions.md` › Resumen del hito 2 y disposición.
- **Hecho en esta sesión:** auditoría de 2.2 con precondiciones fuertes (`If-Match` fuerte y `*`, `If-Unmodified-Since`: 400; control sin precondición: 200); el host del poll ya no lee `gateway_state.json` (2.4); candidato 0.18.0 con cifras re-medidas, tarball de 2092 entradas (shasum e6ef1efb…, sha256 6c095ae6…), instalación aislada sana.
- **Accesos que faltan (no son autorizaciones):** GitLab de prueba (2.1, 2.9 → 5.1, 2.7) y credencial de inferencia para un `HERMES_HOME` desechable (2.3 → 5.3–5.5, 6.1, 2.7; 2.8 solo si 2.3 fracasa).
- **Publicación:** 3.24 espera la aprobación concreta del candidato.

## Cierre operativo (e), 2026-11-24
- Candidato 0.18.0 reproducido bit a bit desde `dd6df0e` (shasum e6ef1efb…, sha256 6c095ae6…, 4.819.800 B, 2092 entradas); CI de `dd6df0e` en verde; 0.18.0 no publicada (E404). Operación preparada: `npm publish <tgz> --access public` (publica exactamente el artefacto verificado, sin repetir prepublishOnly).
- Bloqueos de acceso (no de autorización): `npm whoami` → E401 (sin sesión de npm); sin `%USERPROFILE%\.ai-hub-lab\gitlab-test.env`; sin `HERMES_HOME` desechable con inferencia (Hermes pide `hermes pm repair` para un home nuevo y ese comando reconstruye el entorno de la instalación compartida: no se ejecuta sin la persona).
- Preparado: `%USERPROFILE%\.ai-hub-lab\README.md`, `gitlab-test.env.example` y `experiments/bt_gitlab.py` (2.1 y 2.9 con el protocolo de GitHub; token solo en cabeceras).
