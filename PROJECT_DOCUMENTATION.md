# Smartboard AI Project Documentation

## Overview

Smartboard AI is a local full-stack web application that converts uploaded engineering drawing images into a renderable 3D CAD-style model.

The user uploads one or more drawing images from the frontend, optionally adds dimension notes, and sends them to the backend. The backend sends the drawing images and notes to a Groq vision model, asks for structured CAD JSON, sanitizes the result, and returns supported geometry operations. The frontend converts those operations into 3D solids and renders the model interactively in the browser.

## Technical Stack

### Frontend

- **React 19**: Main UI framework.
- **TypeScript**: Type-safe frontend source.
- **Vite 8**: Development server, build tool, and API proxy.
- **Three.js**: Low-level 3D rendering primitives.
- **@react-three/fiber**: React renderer for Three.js.
- **@react-three/drei**: Helper components such as `Stage` and `OrbitControls`.
- **@jscad/modeling**: CAD-like solid modeling, boolean union/subtract operations, extrusion, cuboids, cylinders, wedges, and polyhedrons.
- **ESLint**: Frontend linting.

### Backend

- **Node.js**: Runtime.
- **Express 5**: HTTP API server.
- **Multer**: Handles multipart image uploads in memory.
- **CORS**: Allows browser clients to call the backend.
- **dotenv**: Loads environment variables from `.env`.
- **groq-sdk**: Sends chat/vision requests to Groq.

### AI Provider

- **Groq API**
- Default model: `meta-llama/llama-4-scout-17b-16e-instruct`
- Configurable with `GROQ_MODEL` in `backend/.env`
- Requires `GROQ_API_KEY` in `backend/.env`

## Project Structure

```text
smartboard ai/
  package.json
  package-lock.json
  TODO.md
  PROJECT_DOCUMENTATION.md
  backend/
    server.js
    server-complete.js
    package.json
    .env
    *.log
    test-upload.png
  frontend/
    package.json
    vite.config.js
    eslint.config.js
    tsconfig.json
    tsconfig.app.json
    tsconfig.node.json
    index.html
    public/
      favicon.svg
      icons.svg
    src/
      main.tsx
      App.tsx
      App.css
      index.css
      assets/
    dist/
```

## Important Files

### Root `package.json`

Provides convenience scripts that run frontend and backend commands from the repo root.

```json
{
  "start:backend": "npm --prefix backend run start",
  "start:frontend": "npm --prefix frontend run dev",
  "build": "npm --prefix frontend run build",
  "lint": "npm --prefix frontend run lint"
}
```

### `backend/server.js`

Thin entry file that loads the complete backend:

```js
require('./server-complete');
```

### `backend/server-complete.js`

Main backend implementation. Responsibilities:

- Starts an Express server.
- Loads Groq API configuration from environment variables.
- Accepts uploaded images at `POST /api/extract-cad`.
- Builds a CAD reconstruction prompt.
- Sends images and notes to Groq.
- Parses the AI response as JSON.
- Sanitizes CAD operations and parts.
- Repairs some common model issues such as disconnected L-bracket boxes, invalid cuts, unsupported fillets, and floating gussets.
- Returns renderable CAD JSON to the frontend.

### `frontend/src/App.tsx`

Main frontend implementation. Responsibilities:

- Displays upload controls and dimension notes textarea.
- Sends files and notes to `/api/extract-cad`.
- Validates returned CAD data.
- Converts supported CAD operations into JSCAD solids.
- Applies boolean operations for cuts.
- Converts JSCAD solids into Three.js `BufferGeometry`.
- Renders the model with React Three Fiber.
- Shows assumptions and raw returned JSON.

### `frontend/vite.config.js`

Configures Vite and proxies API requests:

```js
server: {
  proxy: {
    '/api': 'http://127.0.0.1:5000',
  },
}
```

This means frontend code can call `/api/extract-cad` without hardcoding the backend URL.

## Runtime Workflow

1. User opens the frontend in the browser.
2. User selects one or more drawing images.
3. User optionally enters manual dimension notes.
4. Frontend builds a `FormData` payload:
   - `images`: one or more image files.
   - `notes`: optional user notes.
5. Frontend sends `POST /api/extract-cad`.
6. Vite dev server proxies `/api` to `http://127.0.0.1:5000`.
7. Backend receives files with Multer memory storage.
8. Backend converts image buffers to base64 data URLs.
9. Backend creates a CAD reconstruction prompt.
10. Backend calls Groq chat completions with text plus image content.
11. Groq returns a JSON object describing CAD operations and/or parts.
12. Backend parses and sanitizes the response.
13. Backend returns clean CAD JSON.
14. Frontend validates the response.
15. Frontend converts operations into 3D geometry.
16. React Three Fiber renders the generated model.
17. User can inspect the result with orbit controls.

## Backend API

### `POST /api/extract-cad`

Accepts multipart form data.

Supported file fields:

- `image`: single image, max count 1.
- `images`: multiple images, max count 6.

Supported text fields:

- `notes`: optional dimension or modeling notes.

Example frontend request:

```ts
const formData = new FormData();
selectedFiles.forEach((file) => formData.append('images', file));
formData.append('notes', dimensionNotes);

await fetch('/api/extract-cad', {
  method: 'POST',
  body: formData,
});
```

### Successful Response Shape

The backend prefers an operation-based schema:

```json
{
  "units": "mm",
  "assumptions": ["short notes about inferred dimensions"],
  "operations": [
    {
      "op": "box",
      "name": "base block",
      "size": [100, 20, 60],
      "position": [50, 10, 30],
      "color": "#30cfd0"
    }
  ],
  "parts": []
}
```

### Error Responses

Common backend errors:

- `400`: no image uploaded.
- `500`: missing API key or failed JSON parsing.
- `502`: Groq API connection or provider error.
- `422`: AI response did not contain renderable CAD data.

## Supported CAD Operations

The backend and frontend currently support these operation names:

- `box`: add cuboid material.
- `cutBox`: subtract cuboid volume.
- `roundedPlate`: add a rectangular plate with rounded 2D outline corners.
- `cylinder`: add cylindrical material.
- `cutCylinder`: subtract cylindrical hole volume.
- `wedge`: add sloped wedge material.
- `cutWedge`: subtract sloped wedge volume.
- `gusset`: add triangular support rib between base and wall.
- `triangularPrism`: add triangular prism material.
- `polyhedron`: add custom indexed-face solid.

Operations execute in order. Additive operations create material. Cut operations subtract from the current union of solids.

## Frontend Rendering Pipeline

The frontend supports two data formats:

- **Legacy format** with `profile`, `depth`, and `rib`.
- **Assembly format** with `operations` and/or `parts`.

For the assembly format:

1. Each operation is converted to a JSCAD solid.
2. Additive solids are collected.
3. Cut operations subtract from the union of existing solids.
4. Final solids are unioned.
5. JSCAD polygons are converted to a Three.js `BufferGeometry`.
6. The geometry is rendered as a mesh in a `<Canvas>`.

## Coordinate System

The backend prompt and frontend operation types use:

- **X**: left/right width.
- **Y**: vertical height.
- **Z**: front/back depth.

All positions are center points, not corner points.

Units are expected to be millimeters.

## How To Run

Install dependencies if needed:

```powershell
npm install
npm --prefix backend install
npm --prefix frontend install
```

Start the backend:

```powershell
npm run start:backend
```

Start the frontend in a second terminal:

```powershell
npm run start:frontend
```

Default URLs:

- Backend: `http://localhost:5000`
- Frontend: usually `http://localhost:5173`

## Build And Lint

Build frontend:

```powershell
npm run build
```

Lint frontend:

```powershell
npm run lint
```

Backend syntax check:

```powershell
npm --prefix backend run check
```

## Environment Variables

Backend environment variables belong in `backend/.env`.

Required:

```text
GROQ_API_KEY=your_groq_api_key
```

Optional:

```text
GROQ_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
PORT=5000
```

Do not commit real API keys to source control.

## Current Implementation Notes

- The root app uses separate `backend` and `frontend` packages.
- `backend/server.js` delegates to `backend/server-complete.js`.
- The backend uses in-memory uploads, so uploaded image files are not saved permanently.
- The frontend currently contains most rendering logic in a single large `App.tsx` file.
- `frontend/src/App.css` and `frontend/src/index.css` still contain some template-style CSS, while the active app layout mainly uses inline styles in `App.tsx`.
- The repo contains generated logs and `frontend/dist`; these are runtime/build artifacts rather than core source.
- `TODO.md` indicates the project was migrated from Gemini to Groq and still lists endpoint testing and old dependency cleanup as remaining tasks.

## Suggested Development Workflow

1. Start backend with `npm run start:backend`.
2. Start frontend with `npm run start:frontend`.
3. Upload one or more drawing images.
4. Add clear dimension notes when drawings are ambiguous.
5. Inspect generated assumptions and JSON in the left panel.
6. If geometry is wrong, refine the user notes or backend prompt.
7. Run `npm run build` before sharing production frontend output.
8. Run `npm --prefix backend run check` after backend edits.

## Known Risks And Improvement Areas

- The Groq output is AI-generated, so the backend must continue validating and sanitizing every response.
- Complex mechanical shapes may need additional operations beyond the current schema.
- Boolean operations can become expensive or fail for malformed solids.
- Current API accepts up to six images but does not enforce file size or MIME validation beyond the upload field.
- The backend uses `origin: '*'` CORS, which is convenient for development but broad for production.
- Real API keys should be removed from committed files and loaded securely.
- Splitting `App.tsx` into CAD types, geometry builders, API client, and UI components would improve maintainability.
