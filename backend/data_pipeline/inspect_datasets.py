import requests

DATASETS = [
    ("destinos_turisticos", "https://opendata.euskadi.eus/contenidos/ds_recursos_turisticos/destinos_turisticos/opendata/destinos.geojson"),
    ("rutas_y_paseos", "https://opendata.euskadi.eus/contenidos/ds_recursos_turisticos/rutas_paseos_euskadi/opendata/rutas.geojson"),
    ("hoteles", "https://opendata.euskadi.eus/contenidos/ds_recursos_turisticos/hoteles_de_euskadi/opendata/alojamientos.geojson"),
    ("restaurantes", "https://opendata.euskadi.eus/contenidos/ds_recursos_turisticos/restaurantes_sidrerias_bodegas/opendata/restaurantes.geojson"),
]

for name, url in DATASETS:
    print(f"\n=== {name} ===")
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    data = r.json()
    feats = data.get("features") or []
    print(f"Features: {len(feats)}")
    if not feats:
        continue
    props = feats[0].get("properties", {}) or {}
    print("Algunas keys de properties:")
    for k in list(props.keys())[:20]:
        print(" -", k)
