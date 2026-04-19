# TAG Online (4 jugadores)

Juego tipo "la lleva" multijugador online con salas privadas, máximo 4 jugadores por sala, y duración configurable por partida.

## Características

- Salas privadas por código (ej: `AB12CD`).
- Hasta 4 jugadores concurrentes por sala.
- Timer configurable al crear sala (`1` a `60` minutos).
- Fin automático de partida y anuncio de ganador.
- Ranking por tiempo acumulado sin ser "la lleva".
- Cliente web en `canvas` + backend Node.js sin dependencias externas.

## Requisitos

- Node.js `18+` (recomendado `20+`).

## Ejecutar en local

```bash
node server.js
```

Luego abre:

- [http://localhost:3000](http://localhost:3000)

## Cómo jugar

1. Ingresa tu nombre.
2. Define un código de sala o deja que se genere al crear.
3. Elige minutos de duración (solo aplica al crear sala).
4. Presiona `Crear sala` o `Unirse`.
5. Comparte el código de sala con tus amigos.

### Controles

- Moverse: `W`, `A`, `S`, `D`
- Alternativa: flechas del teclado

## Reglas de juego

- Un jugador es "la lleva".
- Si toca a otro jugador, "la lleva" cambia.
- Gana quien acumule más tiempo sin ser "la lleva" al terminar el tiempo.

## Deploy en Render

Este repo incluye `render.yaml` para facilitar el despliegue.

### Opción rápida (Dashboard)

1. Ir a Render: [https://dashboard.render.com/new/web-service](https://dashboard.render.com/new/web-service)
2. Conectar repo: `https://github.com/demaiol/TAG`
3. Configurar:
   - **Language**: `Node`
   - **Build Command**: vacío (o `npm install`)
   - **Start Command**: `node server.js`
4. Deploy.

### Redeploy luego de cambios

- Push a `main` y Render hará auto-deploy (si está activo), o usar `Manual Deploy -> Deploy latest commit`.

## Estructura

- `server.js`: backend HTTP + lógica de salas/partida/timer.
- `public/index.html`: cliente web (UI + render + input + polling).
- `render.yaml`: configuración de servicio web para Render.

## Troubleshooting

- Si no ves cambios luego de deploy: recarga forzada (`Cmd+Shift+R` / `Ctrl+Shift+R`).
- Si una sala ya terminó: crea una nueva sala.
- Si la sala está llena: máximo 4 jugadores, usa otro código.
