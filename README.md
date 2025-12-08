# MyWordle (до 4 игроков)

Мультиплеерный MyWordle с русскими словами. Бэкенд на FastAPI, фронтенд на React (Vite). Лобби по коду, возможность выбирать длину слова, есть классический режим и гонка на время, поддерживается командная игра (A/B) с общим счётом.

## Запуск бэкенда (FastAPI)

```bash
cd /Users/little_wretch/Documents/wordle
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r backend/requirements.txt
uvicorn app.main:app --reload --app-dir backend --host 0.0.0.0 --port 8000
```

## Запуск фронтенда (Vite + React)

```bash
cd /Users/little_wretch/Documents/wordle/frontend
npm install
npm run dev
```

По умолчанию фронт ожидает API на `http://localhost:8000`. При необходимости задайте `VITE_API_URL` и `VITE_WS_URL` в `.env` (в папке `frontend`).

## Возможности

- До 4 игроков в лобби по коду
- Выбор длины слова (берётся из словаря `backend/data/words_ru.txt`)
- Классический режим и тайм-гонка с авто-переходом на новые слова
- Командный режим (команды A/B) с общим счётом и прогрессом
- Вебсокет для синхронного состояния лобби
- Проверка слов, выдача статусов букв (correct/present/absent)

