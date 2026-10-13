# iPad HLS (Real-Debrid → Safari, iOS 12)

Mali server bez zavisnosti (samo Node 20+ i `ffmpeg`). Izabereš epizodu → otvori se stranica u Safariju →
video ide kao HLS (H.264 + AAC) sa **japanskim audiom** i **engleskim titlovima**.

## Pokretanje

1. U `.env` dodaj `RD_TOKEN=...` (sa https://real-debrid.com/apitoken). Ostale opcije: `.env.example`.
2. `npm start`
3. U konzoli piše adresa, npr. `http://192.168.1.29:3000/`.

## Dva načina gledanja

**A) Bez Stremio-a (najprostije):** na iPadu otvori `http://<IP>:3000/` u Safariju
(Share → *Add to Home Screen* za ikonicu i pravi fullscreen). Pretraga → serija → epizoda → izvor → ▶.

**B) Kroz Stremio:** dodaj addon `http://<IP>:3000/manifest.json`. Kod epizode se pojavljuju izvori
„iPad”; klik otvara stranicu za gledanje u novom prozoru. (Ako Stremio web odbije `http` addon,
pusti ngrok i podesi `PUBLIC_URL` — sam video i dalje ide preko lokalne mreže.)

## Šta radi

- **Serije:** sezone kao tabovi, duge serije (One Piece…) u blokovima po 50 epizoda, polje „Epizoda #”
  za skok, sličice epizoda, „poslednje gledano” i „Nastavi gledanje” na početnoj.
- **Izvori:** samo fajlovi do `MAX_SIZE_GB` (podrazumevano 1,5 GB); ⚡ (već na RD-u) i izdanja koja
  verovatno imaju engleski titl idu prva.
- **Zvuk:** prvi `jpn`; u plejeru (dugme *Titl*) može da se izabere drugi.
- **Titlovi:** server izvlači sve ugrađene tekstualne titlove i čisti ih (karaoke slovo-po-slovo,
  natpisi, crteži), a dodaje i engleske sa OpenSubtitles-a. Plejer ih crta sam, pa rade i u fullscreen-u.
  U panelu *Titl* biraš titl (sa primerom rečenice), pomeraš sinhronizaciju i menjaš veličinu.
  Ćirilični titl označen kao „eng” se prepoznaje i ne bira se automatski.
- **Video:** H.264 8-bit ≤1080p se samo kopira; HEVC/10-bit/ostalo se transkoduje u H.264.
  PGS (slika) titlovi se „upeku” samo ako nema tekstualnog engleskog.
- **Premotavanje:** traka pokazuje šta je konvertovano; skok van toga pokreće konverziju od te tačke.
  Pozicija se pamti („Nastavi od…”), a dugme *Sledeća* vodi na sledeću epizodu.
- Jedan video u isto vreme; novi zaustavlja stari.

Stara (WebTorrent/Stremio-in-app) verzija je u `legacy/` (`npm run legacy`).
