// MapLibre GL is published only as an ES module. Load it and the Leaflet
// plugin (through the page's import map) and expose window.maplibregl and
// L.maplibreGL for code that runs after the page's module scripts.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl-leaflet';

// MapLibre derives its worker URL only for http(s) pages; name the bundled
// worker explicitly for these file:// windows.
maplibregl.setWorkerUrl(new URL('../../vendor/maplibre/maplibre-gl-worker.mjs', import.meta.url).href);

window.maplibregl = maplibregl;
