from __future__ import annotations

import asyncio
import time
import json
import random
import string
import logging
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from fastapi import HTTPException, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_PATH_TARGET = BASE_DIR / "data" / "words_ru.txt"
DATA_PATH_ALLOWED = BASE_DIR / "data" / "words.txt"
MAX_PLAYERS = 4


def normalize_word(word: str) -> str:
    """Lowercase and replace ё with е to unify alphabet."""
    return word.strip().lower().replace("ё", "е")


def _load_words(path: Path) -> Dict[int, List[str]]:
    if not path.exists():
        raise RuntimeError(f"Word list not found at {path}")
    by_length: Dict[int, List[str]] = {}
    try:
        handle = path.open("r", encoding="utf-8")
        lines = handle.readlines()
        handle.close()
    except UnicodeDecodeError:
        with path.open("r", encoding="latin-1", errors="ignore") as handle_fallback:
            lines = handle_fallback.readlines()

    for raw in lines:
        word = normalize_word(raw)
        if not word:
            continue
        by_length.setdefault(len(word), []).append(word)
    if not by_length:
        raise RuntimeError(f"Word list is empty: {path}")
    return by_length


TARGET_WORDS_BY_LENGTH = _load_words(DATA_PATH_TARGET)
ALLOWED_GUESS_BY_LENGTH = {length: set(words) for length, words in _load_words(DATA_PATH_ALLOWED).items()}
ALLOWED_LENGTHS = sorted(k for k in TARGET_WORDS_BY_LENGTH.keys() if 4 <= k <= 12)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("wordle")


def generate_code(length: int = 5) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(random.choice(alphabet) for _ in range(length))


def pick_word(word_length: int) -> str:
    try:
        return random.choice(TARGET_WORDS_BY_LENGTH[word_length])
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


def score_attempt(secret: str, guess: str, feedback: List[str]) -> int:
    """Return score for a single attempt based on word length L."""
    L = len(secret)
    correct_points = sum(1 for f in feedback if f == "correct") * L
    present_points = sum(1 for f in feedback if f == "present") * ((L + 1) // 2)
    base = correct_points + present_points
    if all(f == "correct" for f in feedback):
        base += L  # бонус за полное угадывание
    return base


@dataclass
class Guess:
    word: str
    feedback: List[str]
    order: int


@dataclass
class Player:
    id: str
    name: str
    guesses: List[Guess] = field(default_factory=list)
    total_score: int = 0
    team: str = "A"

    def to_public_for(self, viewer_id: Optional[str], viewer_team: Optional[str]) -> dict:
        visible_guesses = viewer_id == self.id or (viewer_team and viewer_team == self.team)
        return {
            "id": self.id,
            "name": self.name,
            "team": self.team,
            "guesses": [
                {"word": g.word, "feedback": g.feedback, "order": g.order} for g in self.guesses
            ]
            if visible_guesses
            else [],
        }


class Lobby:
    def __init__(
        self,
        code: str,
        word_length: int,
        attempts_limit: int,
        host: Player,
        timed_mode: bool = False,
        round_seconds: int = 180,
        auto_advance: bool = True,
        team_mode: bool = False,
    ):
        self.code = code
        self.word_length = word_length
        self.attempts_limit = attempts_limit
        self.timed_mode = timed_mode
        self.round_seconds = round_seconds
        self.auto_advance = auto_advance
        self.team_mode = team_mode
        self.host_id = host.id
        self.word: Optional[str] = None
        self.started: bool = False
        self.winner_id: Optional[str] = None
        self.winner_team_id: Optional[str] = None
        self.last_solved_word: Optional[str] = None
        self.players: Dict[str, Player] = {host.id: host}
        self.connections: List[Tuple[WebSocket, str]] = []
        self.best_attempt_scores: Dict[str, int] = {}  # per-player for current word
        self.round_ends_at: Optional[float] = None  # timestamp
        self.word_solved: bool = False
        self.team_scores: Dict[str, int] = {"A": 0, "B": 0} if team_mode else {}
        self.no_winner_finished: bool = False
        self.failed_word: Optional[str] = None
        self.guess_counter: int = 0  # общий счетчик попыток
        # для тайм-режима с последовательными словами
        self.word_sequence: List[str] = []
        # позиция по последовательности для команды/игрока
        self.group_progress: Dict[str, int] = {}

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
        self.started = True
        self.winner_id = None
        self.winner_team_id = None
        self.last_solved_word = None
        self.best_attempt_scores = {}
        self.word_solved = False
        self.no_winner_finished = False
        self.failed_word = None
        self.guess_counter = 0
        self.word_sequence = []
        self.group_progress = {}
        # сбрасываем очки и попытки
        for p in self.players.values():
            p.total_score = 0
            p.guesses.clear()
        if self.team_mode:
            self.team_scores = {"A": 0, "B": 0}
        if self.timed_mode:
            first = pick_word(self.word_length)
            self.word_sequence = [first]
            if self.team_mode:
                self.group_progress = {"A": 0, "B": 0}
            else:
                self.group_progress = {pid: 0 for pid in self.players.keys()}
            self.word = None
            logger.info("Start timed sequence: step0=%s", first)
            self.round_ends_at = time.time() + self.round_seconds
        else:
            self.word = pick_word(self.word_length)
            logger.info("Start classic: %s", self.word)
            self.round_ends_at = None

    def restart(self, player_id: str) -> None:
        if player_id != self.host_id:
            raise HTTPException(status_code=403, detail="Только создатель может перезапустить игру")
        if not self.started and not self.winner_id and not self.no_winner_finished and not self.timed_mode:
            raise HTTPException(status_code=400, detail="Перезапуск возможен после окончания раунда")
        self.started = True
        self.winner_id = None
        self.winner_team_id = None
        self.last_solved_word = None
        self.best_attempt_scores = {}
        self.word_solved = False
        self.no_winner_finished = False
        self.failed_word = None
        self.guess_counter = 0
        self.word_sequence = []
        self.group_progress = {}
        for p in self.players.values():
            p.guesses.clear()
            p.total_score = 0
        if self.team_mode:
            self.team_scores = {"A": 0, "B": 0}
        if self.timed_mode:
            first = pick_word(self.word_length)
            self.word_sequence = [first]
            if self.team_mode:
                self.group_progress = {"A": 0, "B": 0}
            else:
                self.group_progress = {pid: 0 for pid in self.players.keys()}
            self.word = None
            logger.info("Restart timed sequence: step0=%s", first)
            self.round_ends_at = time.time() + self.round_seconds
        else:
            self.word = pick_word(self.word_length)
            logger.info("Restart classic: %s", self.word)
            self.round_ends_at = None

    def _check_time_expired(self) -> bool:
        if self.timed_mode and self.round_ends_at:
            if time.time() > self.round_ends_at:
                self.started = False
                return True
        return False

    def apply_guess(self, player_id: str, guess_word: str) -> Guess:
        if not self.started:
            raise HTTPException(status_code=400, detail="Игра еще не началась")
        if self._check_time_expired():
            raise HTTPException(status_code=400, detail="Время раунда истекло")
        player = self.players.get(player_id)
        if not player:
            raise HTTPException(status_code=404, detail="Игрок не найден")
        if len(player.guesses) >= self.attempts_limit:
            raise HTTPException(status_code=400, detail="Попытки игрока закончились")

        # определяем группу (команда или игрок) и берем слово из последовательности
        group_id = player.team if self.team_mode else player_id
        if self.timed_mode:
            if group_id not in self.group_progress:
                # новый игрок в процессе раунда - присваиваем стартовую позицию
                self.group_progress[group_id] = 0
            idx = self.group_progress[group_id]
            if idx >= len(self.word_sequence):
                # защита, не должно случаться
                self.word_sequence.append(pick_word(self.word_length))
            secret = self.word_sequence[idx]
        else:
            if not self.word:
                raise HTTPException(status_code=400, detail="Секрет не задан")
            secret = self.word

        guess_word = normalize_word(guess_word)
        if len(guess_word) != len(secret):
            raise HTTPException(status_code=400, detail="Неверная длина слова")
        allowed_set = ALLOWED_GUESS_BY_LENGTH.get(len(secret), set())
        target_set = set(TARGET_WORDS_BY_LENGTH.get(len(secret), []))
        if guess_word not in allowed_set and guess_word not in target_set:
            raise HTTPException(status_code=400, detail="Слова нет в словаре")

        feedback = evaluate_guess(secret, guess_word)
        self.guess_counter += 1
        order_val = self.guess_counter

        guess = Guess(word=guess_word, feedback=feedback, order=order_val)
        player.guesses.append(guess)

        attempt_score = score_attempt(secret, guess_word, feedback) if self.timed_mode else 0
        if self.timed_mode:
            best_key = player.team if self.team_mode else player_id
            prev_best = self.best_attempt_scores.get(best_key, 0)
            if attempt_score > prev_best:
                delta = attempt_score - prev_best
                player.total_score += delta
                self.best_attempt_scores[best_key] = attempt_score
                if self.team_mode:
                    self.team_scores[player.team] = self.team_scores.get(player.team, 0) + delta

        if guess_word == secret:
            if not self.timed_mode:
                self.winner_id = player_id
                self.winner_team_id = player.team if self.team_mode else None
                self.word_solved = True
                self.last_solved_word = secret
                logger.info("Classic solved by %s (%s): %s", player.name, player.id, secret)
            else:
                # тайм-режим: последовательность общая, прогресс у каждой группы свой
                self.last_solved_word = secret
                logger.info("Timed solved by %s (%s team %s): %s", player.name, player.id, player.team, secret)
                if self.auto_advance:
                    # двигаем группу на следующий индекс
                    current_idx = self.group_progress.get(player.team if self.team_mode else player_id, 0)
                    next_idx = current_idx + 1
                    # при необходимости расширяем последовательность одним новым словом
                    if next_idx >= len(self.word_sequence):
                        new_word = pick_word(self.word_length)
                        self.word_sequence.append(new_word)
                        logger.info("Timed sequence append step%d=%s", next_idx, new_word)
                    # обновляем прогресс для группы
                    group_key = player.team if self.team_mode else player_id
                    self.group_progress[group_key] = next_idx
                    # сбрасываем попытки и best score у группы (команда/игрок)
                    if self.team_mode:
                        for pl in self.players.values():
                            if pl.team == group_key:
                                pl.guesses.clear()
                        self.best_attempt_scores[group_key] = 0
                    else:
                        player.guesses.clear()
                        self.best_attempt_scores[player_id] = 0

        # если классика и у всех закончились попытки, завершаем раунд без победителя
        if not self.timed_mode and not self.winner_id:
            all_out = all(len(p.guesses) >= self.attempts_limit for p in self.players.values())
            if all_out:
                self.started = False
                self.no_winner_finished = True
                self.failed_word = self.word
        return guess

    def to_public_for(self, viewer_id: Optional[str]) -> dict:
        timed_finished = self._check_time_expired()
        viewer_team = None
        if viewer_id and viewer_id in self.players:
            viewer_team = self.players[viewer_id].team
        remaining_seconds = None
        if self.timed_mode and self.round_ends_at:
            remaining_seconds = max(0, int(self.round_ends_at - time.time()))
        return {
            "code": self.code,
            "wordLength": self.word_length,
            "attemptsLimit": self.attempts_limit,
            "timedMode": self.timed_mode,
            "roundSeconds": self.round_seconds,
            "roundEndsAt": self.round_ends_at,
            "roundRemainingSeconds": remaining_seconds,
            "autoAdvance": self.auto_advance,
            "teamMode": self.team_mode,
            "hostId": self.host_id,
            "started": self.started and not timed_finished,
            "winnerId": self.winner_id,
            "winnerTeamId": self.winner_team_id,
            "winnerWord": self.word if self.winner_id and not self.timed_mode else None,
            "lastSolvedWord": self.last_solved_word,
            "players": [p.to_public_for(viewer_id, viewer_team) for p in self.players.values()],
            "scores": {pid: p.total_score for pid, p in self.players.items()},
            "teamScores": self.team_scores if self.team_mode else None,
            "timedFinished": timed_finished,
            "noWinnerFinished": self.no_winner_finished if not self.timed_mode else False,
            "failedWord": self.failed_word if self.no_winner_finished else None,
            "wordSequence": self.word_sequence if self.timed_mode else None,
        }


class ConnectionManager:
    def __init__(self) -> None:
        self.lobbies: Dict[str, Lobby] = {}

    def create_lobby(
        self,
        word_length: int,
        attempts_limit: int,
        host_name: str,
        timed_mode: bool,
        round_seconds: int,
        auto_advance: bool,
        team_mode: bool,
    ) -> dict:
        if word_length not in ALLOWED_LENGTHS:
            raise HTTPException(status_code=400, detail=f"Доступные длины: {ALLOWED_LENGTHS}")
        code = generate_code()
        host = Player(id=generate_code(8), name=host_name)
        lobby = Lobby(
            code=code,
            word_length=word_length,
            attempts_limit=attempts_limit,
            host=host,
            timed_mode=timed_mode,
            round_seconds=round_seconds,
            auto_advance=auto_advance,
            team_mode=team_mode,
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
    timed_mode: bool = False
    round_seconds: int = Field(180, ge=30, le=600)
    auto_advance: bool = True
    team_mode: bool = False


class TeamChangeRequest(BaseModel):
    player_id: str
    target_id: str
    team: str


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
        timed_mode=body.timed_mode,
        round_seconds=body.round_seconds,
        auto_advance=body.auto_advance,
        team_mode=body.team_mode,
    )


@app.post("/lobby/{code}/join")
async def join_lobby(code: str, body: JoinLobbyRequest) -> dict:
    lobby = manager.get_lobby(code)
    # чередуем команды A/B
    if lobby.team_mode:
        count_a = sum(1 for p in lobby.players.values() if p.team == "A")
        count_b = sum(1 for p in lobby.players.values() if p.team == "B")
        team = "A" if count_a <= count_b else "B"
    else:
        team = "A"
    player = Player(id=generate_code(8), name=body.player_name.strip(), team=team)
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


@app.post("/lobby/{code}/team")
async def change_team(code: str, body: TeamChangeRequest) -> dict:
    lobby = manager.get_lobby(code)
    if body.player_id != lobby.host_id:
        raise HTTPException(status_code=403, detail="Только хост может менять команды")
    target = lobby.players.get(body.target_id)
    if not target:
        raise HTTPException(status_code=404, detail="Игрок не найден")
    if body.team not in {"A", "B"}:
        raise HTTPException(status_code=400, detail="Команда должна быть A или B")
    target.team = body.team
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
            try:
                await websocket.receive_text()
            except WebSocketDisconnect:
                break
    finally:
        manager.disconnect(lobby, websocket)

