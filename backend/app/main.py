from __future__ import annotations

import asyncio
import json
import random
import string
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from fastapi import HTTPException, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_PATH = BASE_DIR / "data" / "words_ru.txt"
MAX_PLAYERS = 4


def _load_words() -> Dict[int, List[str]]:
    if not DATA_PATH.exists():
        raise RuntimeError(f"Word list not found at {DATA_PATH}")
    by_length: Dict[int, List[str]] = {}
    with DATA_PATH.open("r", encoding="utf-8") as handle:
        for raw in handle:
            word = raw.strip().lower()
            if not word:
                continue
            by_length.setdefault(len(word), []).append(word)
    if not by_length:
        raise RuntimeError("Word list is empty")
    return by_length


WORDS_BY_LENGTH = _load_words()
ALLOWED_LENGTHS = sorted(k for k in WORDS_BY_LENGTH.keys() if 4 <= k <= 12)


def generate_code(length: int = 5) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(random.choice(alphabet) for _ in range(length))


def pick_word(word_length: int) -> str:
    try:
        return random.choice(WORDS_BY_LENGTH[word_length])
    except KeyError as exc:  # pragma: no cover - validated earlier
        raise HTTPException(status_code=400, detail="Нет слов такой длины") from exc


def evaluate_guess(secret: str, guess: str) -> List[str]:
    """Return per-letter statuses: correct, present, absent."""
    guess = guess.lower()
    secret = secret.lower()
    feedback = ["absent"] * len(secret)
    counts = Counter(secret)

    for idx, letter in enumerate(guess):
        if secret[idx] == letter:
            feedback[idx] = "correct"
            counts[letter] -= 1

    for idx, letter in enumerate(guess):
        if feedback[idx] != "absent":
            continue
        if counts.get(letter, 0) > 0:
            feedback[idx] = "present"
            counts[letter] -= 1

    return feedback


@dataclass
class Guess:
    word: str
    feedback: List[str]


@dataclass
class Player:
    id: str
    name: str
    guesses: List[Guess] = field(default_factory=list)

    def to_public_for(self, viewer_id: Optional[str]) -> dict:
        visible_guesses = viewer_id == self.id
        return {
            "id": self.id,
            "name": self.name,
            "guesses": [
                {"word": g.word, "feedback": g.feedback} for g in self.guesses
            ]
            if visible_guesses
            else [],
        }


class Lobby:
    def __init__(self, code: str, word_length: int, attempts_limit: int, host: Player):
        self.code = code
        self.word_length = word_length
        self.attempts_limit = attempts_limit
        self.host_id = host.id
        self.word: Optional[str] = None
        self.started: bool = False
        self.winner_id: Optional[str] = None
        self.players: Dict[str, Player] = {host.id: host}
        self.connections: List[Tuple[WebSocket, str]] = []

    @property
    def is_full(self) -> bool:
        return len(self.players) >= MAX_PLAYERS

    def add_player(self, player: Player) -> None:
        if self.started:
            raise HTTPException(status_code=400, detail="Игра уже началась")
        if self.is_full:
            raise HTTPException(status_code=400, detail="Лобби заполнено")
        self.players[player.id] = player

    def remove_player(self, actor_id: str, target_id: str) -> None:
        if actor_id != self.host_id:
            raise HTTPException(status_code=403, detail="Только создатель может удалять игроков")
        if target_id == self.host_id:
            raise HTTPException(status_code=400, detail="Нельзя удалить создателя")
        if target_id not in self.players:
            raise HTTPException(status_code=404, detail="Игрок не найден")
        self.players.pop(target_id)
        if self.winner_id == target_id:
            self.winner_id = None
        # закрываем WS kicked-игрока, если он в списке подключений
        loop = asyncio.get_event_loop()
        for ws, pid in list(self.connections):
            if pid == target_id:
                try:
                    loop.create_task(ws.close(code=4401, reason="kicked"))
                except Exception:
                    pass
                self.connections.remove((ws, pid))

    def start(self, player_id: str) -> None:
        if player_id != self.host_id:
            raise HTTPException(status_code=403, detail="Только создатель может начать игру")
        if self.started:
            return
        self.word = pick_word(self.word_length)
        self.started = True
        self.winner_id = None

    def restart(self, player_id: str) -> None:
        if player_id != self.host_id:
            raise HTTPException(status_code=403, detail="Только создатель может перезапустить игру")
        if not self.winner_id:
            raise HTTPException(status_code=400, detail="Сначала завершите текущую партию")

        self.word = pick_word(self.word_length)
        self.started = True
        self.winner_id = None
        for player in self.players.values():
            player.guesses.clear()
        self.winner_id = None
        for p in self.players.values():
            p.guesses.clear()

    def restart(self, player_id: str) -> None:
        if player_id != self.host_id:
            raise HTTPException(status_code=403, detail="Только создатель может перезапустить игру")
        if not self.started or self.winner_id is None:
            raise HTTPException(status_code=400, detail="Перезапуск возможен после окончания раунда")
        self.word = pick_word(self.word_length)
        self.winner_id = None
        for p in self.players.values():
            p.guesses.clear()

    def apply_guess(self, player_id: str, guess_word: str) -> Guess:
        if not self.started or not self.word:
            raise HTTPException(status_code=400, detail="Игра еще не началась")
        player = self.players.get(player_id)
        if not player:
            raise HTTPException(status_code=404, detail="Игрок не найден")
        if len(player.guesses) >= self.attempts_limit:
            raise HTTPException(status_code=400, detail="Попытки игрока закончились")
        guess_word = guess_word.lower()
        if len(guess_word) != len(self.word):
            raise HTTPException(status_code=400, detail="Неверная длина слова")
        if guess_word not in WORDS_BY_LENGTH.get(len(self.word), []):
            raise HTTPException(status_code=400, detail="Слова нет в словаре")

        feedback = evaluate_guess(self.word, guess_word)
        guess = Guess(word=guess_word, feedback=feedback)
        player.guesses.append(guess)
        if guess_word == self.word:
            self.winner_id = player_id
        return guess

    def to_public_for(self, viewer_id: Optional[str]) -> dict:
        return {
            "code": self.code,
            "wordLength": self.word_length,
            "attemptsLimit": self.attempts_limit,
            "hostId": self.host_id,
            "started": self.started,
            "winnerId": self.winner_id,
            "players": [p.to_public_for(viewer_id) for p in self.players.values()],
        }


class ConnectionManager:
    def __init__(self) -> None:
        self.lobbies: Dict[str, Lobby] = {}

    def create_lobby(self, word_length: int, attempts_limit: int, host_name: str) -> dict:
        if word_length not in ALLOWED_LENGTHS:
            raise HTTPException(status_code=400, detail=f"Доступные длины: {ALLOWED_LENGTHS}")
        code = generate_code()
        host = Player(id=generate_code(8), name=host_name)
        lobby = Lobby(
            code=code,
            word_length=word_length,
            attempts_limit=attempts_limit,
            host=host,
        )
        self.lobbies[code] = lobby
        return {"lobby": lobby.to_public_for(host.id), "playerId": host.id}

    def get_lobby(self, code: str) -> Lobby:
        lobby = self.lobbies.get(code.upper())
        if not lobby:
            raise HTTPException(status_code=404, detail="Лобби не найдено")
        return lobby

    async def delete_lobby(self, code: str, actor_id: str) -> None:
        lobby = self.get_lobby(code)
        if actor_id != lobby.host_id:
            raise HTTPException(status_code=403, detail="Только создатель может удалить лобби")
        # закрываем все подключения с кодом 4101
        for ws, _pid in list(lobby.connections):
            try:
                await ws.close(code=4101, reason="lobby deleted")
            except Exception:
                pass
        self.lobbies.pop(code.upper(), None)

    async def broadcast_state(self, lobby: Lobby) -> None:
        for ws, player_id in list(lobby.connections):
            try:
                message = json.dumps(
                    {"type": "state", "payload": lobby.to_public_for(player_id)},
                    ensure_ascii=False,
                )
                await ws.send_text(message)
            except RuntimeError:
                pass

    async def connect(self, lobby: Lobby, websocket: WebSocket, player_id: str) -> None:
        await websocket.accept()
        lobby.connections.append((websocket, player_id))
        await websocket.send_json(
            {"type": "state", "payload": lobby.to_public_for(player_id)}
        )

    def disconnect(self, lobby: Lobby, websocket: WebSocket) -> None:
        lobby.connections = [
            pair for pair in lobby.connections if pair[0] is not websocket
        ]


class CreateLobbyRequest(BaseModel):
    player_name: str = Field(..., min_length=1, max_length=32)
    word_length: int = Field(..., ge=4, le=12)
    attempts_limit: int = Field(..., ge=4, le=8)


class JoinLobbyRequest(BaseModel):
    player_name: str = Field(..., min_length=1, max_length=32)


class StartGameRequest(BaseModel):
    player_id: str


class GuessRequest(BaseModel):
    player_id: str
    guess: str


class KickRequest(BaseModel):
    player_id: str
    target_id: str


class LeaveRequest(BaseModel):
    player_id: str


class DeleteLobbyRequest(BaseModel):
    player_id: str


class RestartRequest(BaseModel):
    player_id: str


app = FastAPI(title="Wordle RU Multiplayer", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

manager = ConnectionManager()


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/lengths")
async def lengths() -> dict:
    return {"lengths": ALLOWED_LENGTHS}


@app.post("/lobby")
async def create_lobby(body: CreateLobbyRequest) -> dict:
    return manager.create_lobby(
        word_length=body.word_length,
        attempts_limit=body.attempts_limit,
        host_name=body.player_name.strip(),
    )


@app.post("/lobby/{code}/join")
async def join_lobby(code: str, body: JoinLobbyRequest) -> dict:
    lobby = manager.get_lobby(code)
    player = Player(id=generate_code(8), name=body.player_name.strip())
    lobby.add_player(player)
    await manager.broadcast_state(lobby)
    return {"lobby": lobby.to_public_for(player.id), "playerId": player.id}


@app.get("/lobby/{code}")
async def lobby_state(code: str) -> dict:
    lobby = manager.get_lobby(code)
    # Без идентификации игрока выдаём список игроков, но скрываем попытки.
    return lobby.to_public_for(viewer_id=None)


@app.post("/lobby/{code}/start")
async def start_game(code: str, body: StartGameRequest) -> dict:
    lobby = manager.get_lobby(code)
    lobby.start(body.player_id)
    await manager.broadcast_state(lobby)
    return lobby.to_public_for(body.player_id)


@app.post("/lobby/{code}/restart")
async def restart_game(code: str, body: RestartRequest) -> dict:
    lobby = manager.get_lobby(code)
    lobby.restart(body.player_id)
    await manager.broadcast_state(lobby)
    return lobby.to_public_for(body.player_id)


@app.post("/lobby/{code}/guess")
async def make_guess(code: str, body: GuessRequest) -> dict:
    lobby = manager.get_lobby(code)
    guess = lobby.apply_guess(body.player_id, body.guess)
    await manager.broadcast_state(lobby)
    return {
        "guess": {"word": guess.word, "feedback": guess.feedback},
        "lobby": lobby.to_public_for(body.player_id),
    }


@app.post("/lobby/{code}/restart")
async def restart_game(code: str, body: StartGameRequest) -> dict:
    lobby = manager.get_lobby(code)
    lobby.restart(body.player_id)
    await manager.broadcast_state(lobby)
    return lobby.to_public_for(body.player_id)


@app.post("/lobby/{code}/kick")
async def kick_player(code: str, body: KickRequest) -> dict:
    lobby = manager.get_lobby(code)
    lobby.remove_player(actor_id=body.player_id, target_id=body.target_id)
    await manager.broadcast_state(lobby)
    return lobby.to_public_for(body.player_id)


@app.post("/lobby/{code}/leave")
async def leave_lobby(code: str, body: LeaveRequest) -> dict:
    lobby = manager.get_lobby(code)
    if body.player_id not in lobby.players:
        raise HTTPException(status_code=404, detail="Игрок не найден")
    if body.player_id == lobby.host_id:
        raise HTTPException(status_code=400, detail="Создатель не может выйти. Удалите лобби.")
    lobby.players.pop(body.player_id, None)
    if lobby.winner_id == body.player_id:
        lobby.winner_id = None
    # закрываем WS, если подключение существует
    for ws, pid in list(lobby.connections):
        if pid == body.player_id:
            try:
                await ws.close(code=4001)
            except Exception:
                pass
            lobby.connections.remove((ws, pid))
    await manager.broadcast_state(lobby)
    return {"left": True}


@app.post("/lobby/{code}/delete")
async def delete_lobby(code: str, body: DeleteLobbyRequest) -> dict:
    await manager.delete_lobby(code, actor_id=body.player_id)
    return {"deleted": True}


@app.websocket("/ws/{code}/{player_id}")
async def websocket_endpoint(websocket: WebSocket, code: str, player_id: str) -> None:
    lobby = manager.get_lobby(code)
    if player_id not in lobby.players:
        await websocket.close(code=4404)
        return

    await manager.connect(lobby, websocket, player_id)
    try:
        while True:
            await asyncio.wait_for(websocket.receive_text(), timeout=120)
    except asyncio.TimeoutError:
        await websocket.close(code=4000)
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(lobby, websocket)

