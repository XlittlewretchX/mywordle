import { useEffect, useMemo, useState } from "react";
import "./App.css";

const API_URL_RAW = import.meta.env.VITE_API_URL || "http://localhost:8000";
const API_URL = API_URL_RAW.replace(/\/+$/, "");
const WS_URL_RAW = import.meta.env.VITE_WS_URL || API_URL.replace(/^http/, "ws");
const WS_URL = WS_URL_RAW.replace(/\/+$/, "");

const initialLobby = null;

function App() {
  const [playerName, setPlayerName] = useState("");
  const [wordLength, setWordLength] = useState(5);
  const [attemptsLimit, setAttemptsLimit] = useState(6);
  const [availableLengths, setAvailableLengths] = useState([]);
  const [lobbyCode, setLobbyCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [lobby, setLobby] = useState(initialLobby);
  const [message, setMessage] = useState("");
  const [guess, setGuess] = useState("");
  const [wsStatus, setWsStatus] = useState("disconnected");
  const [wsNonce, setWsNonce] = useState(0);

  const isHost = lobby && playerId === lobby.hostId;
  const started = lobby?.started;

  useEffect(() => {
    const loadLengths = async () => {
      try {
        const res = await fetch(`${API_URL}/lengths`);
        const data = await res.json();
        setAvailableLengths(data.lengths || []);
        if (data.lengths?.length) {
          setWordLength(data.lengths[0]);
        }
      } catch (error) {
        setMessage("Не удалось получить список длин слов");
      }
    };
    loadLengths();
  }, []);

  useEffect(() => {
    if (!lobby?.code || !playerId) return undefined;
    const ws = new WebSocket(`${WS_URL}/ws/${lobby.code}/${playerId}`);
    setWsStatus("connecting");

    ws.onopen = () => setWsStatus("connected");
    ws.onclose = (ev) => {
      setWsStatus("disconnected");
      if (ev.code === 4401) {
        notify("Вас удалили из лобби");
        resetClientState();
      }
      if (ev.code === 4001) {
        resetClientState();
      }
      if (ev.code === 4101) {
        notify("Лобби удалено");
        resetClientState();
      }
      // авто-переподключение при обычном разрыве
      if ([4001, 4101, 4401].includes(ev.code)) return;
      if (lobby?.code && playerId) {
        setTimeout(() => setWsNonce((n) => n + 1), 1500);
      }
    };
    ws.onerror = () => setWsStatus("error");
    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "state") {
          const state = payload.payload;
          const inLobby = state.players.some((p) => p.id === playerId);
          if (!inLobby) {
            notify("Вас удалили из лобби");
            resetClientState();
            ws.close();
            return;
          }
          setLobby(state);
        }
      } catch (err) {
        console.error("Bad WS message", err);
      }
    };

    return () => ws.close();
  }, [lobby?.code, playerId, wsNonce]);

  const notify = (text) => {
    setMessage(text);
    setTimeout(() => setMessage(""), 3000);
  };

  const postJson = async (path, body) => {
    const res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const detail = data.detail || "Ошибка запроса";
      throw new Error(detail);
    }
    return res.json();
  };

  const handleCreate = async () => {
    if (!playerName.trim()) return notify("Введите имя");
    try {
      const data = await postJson("/lobby", {
        player_name: playerName.trim(),
        word_length: wordLength,
        attempts_limit: attemptsLimit,
      });
      setPlayerId(data.playerId);
      setLobby(data.lobby);
      setLobbyCode(data.lobby.code);
      setJoinCode(data.lobby.code);
      notify("Лобби создано");
    } catch (error) {
      notify(error.message);
    }
  };

  const handleJoin = async () => {
    if (!playerName.trim()) return notify("Введите имя");
    if (!joinCode.trim()) return notify("Введите код лобби");
    try {
      const code = joinCode.trim().toUpperCase();
      const data = await postJson(`/lobby/${code}/join`, {
        player_name: playerName.trim(),
      });
      setPlayerId(data.playerId);
      setLobby(data.lobby);
      setLobbyCode(code);
      notify("Присоединились к лобби");
    } catch (error) {
      notify(error.message);
    }
  };

  const handleStart = async () => {
    try {
      const data = await postJson(`/lobby/${lobby.code}/start`, { player_id: playerId });
      setLobby(data);
    } catch (error) {
      notify(error.message);
    }
  };

  const handleRestart = async () => {
    try {
      const data = await postJson(`/lobby/${lobby.code}/restart`, { player_id: playerId });
      setLobby(data);
      setGuess("");
    } catch (error) {
      notify(error.message);
    }
  };

  const resetClientState = () => {
    setLobby(initialLobby);
    setPlayerId("");
    setLobbyCode("");
    setJoinCode("");
    setGuess("");
  };

  const handleLeave = async () => {
    if (!lobby) return;
    try {
      await postJson(`/lobby/${lobby.code}/leave`, { player_id: playerId });
      resetClientState();
      notify("Вы покинули лобби");
    } catch (error) {
      notify(error.message);
    }
  };

  const handleKick = async (targetId) => {
    try {
      await postJson(`/lobby/${lobby.code}/kick`, {
        player_id: playerId,
        target_id: targetId,
      });
      notify("Игрок удалён");
    } catch (error) {
      notify(error.message);
    }
  };

  const handleDeleteLobby = async () => {
    if (!lobby) return;
    try {
      await postJson(`/lobby/${lobby.code}/delete`, { player_id: playerId });
      resetClientState();
      notify("Лобби удалено");
    } catch (error) {
      notify(error.message);
    }
  };

  const handleGuess = async (evt) => {
    evt.preventDefault();
    if (!guess.trim()) return;
    const limit = lobby?.attemptsLimit ?? attemptsLimit;
    const used = you?.guesses?.length || 0;
    if (used >= limit) return notify("Попытки закончились");
    if (guess.trim().length !== lobby.wordLength) {
      return notify(`Нужно ${lobby.wordLength} букв`);
    }
    try {
      await postJson(`/lobby/${lobby.code}/guess`, {
        player_id: playerId,
        guess: guess.trim().toLowerCase(),
      });
      setGuess("");
    } catch (error) {
      notify(error.message);
    }
  };

  const playersWithGuesses = useMemo(() => lobby?.players || [], [lobby]);
  const you = useMemo(
    () => playersWithGuesses.find((p) => p.id === playerId),
    [playersWithGuesses, playerId],
  );
  const attemptsUsed = you?.guesses?.length || 0;
  const attemptsLimitValue = lobby?.attemptsLimit ?? attemptsLimit;
  const letterStates = useMemo(() => {
    const map = {};
    if (!you?.guesses) return map;
    you.guesses.forEach((g) => {
      g.feedback.forEach((state, idx) => {
        const letter = g.word[idx];
        const prev = map[letter];
        const priority = { correct: 3, present: 2, absent: 1, idle: 0 };
        if (!prev || priority[state] > priority[prev]) {
          map[letter] = state;
        }
      });
    });
    return map;
  }, [you]);

  const renderGuessRow = (entry) => (
    <div className="guess-row" key={entry.word + entry.feedback.join("")}>
      {entry.word.split("").map((letter, idx) => (
        <span key={idx} className={`tile ${entry.feedback[idx]}`}>
          {letter.toUpperCase()}
        </span>
      ))}
    </div>
  );

  return (
    <div className="page">
      <header className="topbar hero">
        <div className="hero-text">
          <p className="eyebrow">Русский мультиплеер до 4 игроков</p>
          <h1>Wordle RU</h1>
          <p className="subtitle">
            Заходите по коду, выбирайте длину слова и играйте честно: попытки соперников скрыты.
          </p>
          <div className="status-row">
            <span className={`chip ${started ? "chip-live" : "chip-idle"}`}>
              {started ? "Игра идет" : "Ожидаем старт"}
            </span>
            <span className="chip chip-code">Код: {lobby?.code || "—"}</span>
            <span className="chip chip-len">Длина: {lobby?.wordLength || wordLength} букв</span>
            <span className={`chip ${wsStatus}`}>WebSocket: {wsStatus}</span>
          </div>
        </div>
      </header>

      {!lobby && (
        <>
          <section className="card stack name-card">
            <h2>Ваше имя</h2>
            <p className="muted">Покажем его в лобби и в таблице попыток.</p>
            <div className="name-row">
              <input
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                placeholder="Например: Бобус"
                className="name-input"
              />
              <span className="chip chip-idle">Обязательно</span>
            </div>
          </section>

          <section className="grid lobby-actions">
            <div className="card action-block create">
              <h2>Создать лобби</h2>
              <p className="muted">Выберите длину слова и получите код комнаты.</p>
              <div className="inline-selects">
                <label>
                  Длина слова
                  <select
                    value={wordLength}
                    onChange={(e) => setWordLength(Number(e.target.value))}
                  >
                    {availableLengths.map((len) => (
                      <option key={len} value={len}>
                        {len} букв
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Лимит попыток
                  <select
                    value={attemptsLimit}
                    onChange={(e) => setAttemptsLimit(Number(e.target.value))}
                  >
                    {[4, 5, 6, 7, 8].map((n) => (
                      <option key={n} value={n}>
                        {n} попыток
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button className="primary full" onClick={handleCreate} disabled={!playerName.trim()}>
                Создать лобби
              </button>
              {lobbyCode && (
                <div className="hint">
                  Код лобби: <strong>{lobbyCode}</strong>
                </div>
              )}
      </div>

            <div className="card action-block join">
              <h2>Войти по коду</h2>
              <p className="muted">Вставьте код, который вам передал хост.</p>
              <label>
                Код лобби
                <input
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  placeholder="ABCDE"
                />
              </label>
              <button className="primary full" onClick={handleJoin} disabled={!playerName.trim()}>
                Подключиться
        </button>
              <p className="hint">Максимум 4 игрока в комнате.</p>
            </div>
          </section>
        </>
      )}

      {message && (!lobby || !started) && <div className="flash">{message}</div>}

      {lobby && (
        <section className="card">
          <header className="lobby-head">
            <div>
              <h3>Лобби {lobby.code}</h3>
              <p>Длина слова: {lobby.wordLength}</p>
              <p>Лимит попыток: {lobby.attemptsLimit}</p>
              <p>Статус: {lobby.started ? "Идет игра" : "Ждем начала"}</p>
              <p className="muted">
                Ваши попытки видны только вам. Попытки соперников скрыты.
        </p>
      </div>
            {isHost && !started && (
              <button className="primary" onClick={handleStart}>
                Начать игру
              </button>
            )}
            {isHost && (
              <button className="ghost danger" onClick={handleDeleteLobby}>
                Удалить лобби
              </button>
            )}
            {!isHost && (
              <button className="ghost danger" onClick={handleLeave}>
                Выйти
              </button>
            )}
          </header>

          <div className="players">
            {playersWithGuesses.map((p) => (
              <div className="player" key={p.id}>
                <div className="player-head">
                  <div>
                    <strong>{p.name}</strong>
                    {p.id === lobby.hostId && <span className="badge">Хост</span>}
                    {p.id === playerId && <span className="badge you">Вы</span>}
                  </div>
                  {lobby.winnerId === p.id && (
                    <span className="winner">Угадал слово!</span>
                  )}
                  {isHost && p.id !== lobby.hostId && (
                    <button
                      className="ghost danger mini"
                      onClick={() => handleKick(p.id)}
                    >
                      Удалить
                    </button>
                  )}
                </div>
                <div className="guesses">
                  {p.id === playerId ? (
                    <p className="hint">Ваши строки — в блоке «Ваши попытки» ниже.</p>
                  ) : (
                    <p className="hint">Попытки соперников скрыты.</p>
                  )}
                </div>
              </div>
            ))}
          </div>

        </section>
      )}

      {lobby && started && (
        <section className="card play-area">
          <h3>Ваши попытки</h3>
          <p className="muted">
            Угадывайте слово и следите за своими строками. Попытки соперников не отображаются.
          </p>
          <div className="meta-row">
            <span className="chip chip-len">
              Длина: {lobby.wordLength}
            </span>
            <span className="chip chip-code">
              Попытки: {attemptsUsed} / {lobby.attemptsLimit}
            </span>
          </div>
          <div className="board">
            {you?.guesses?.length ? (
              you.guesses.map(renderGuessRow)
            ) : (
              <p className="hint">Пока нет попыток — введите первое слово.</p>
            )}
          </div>

          {!lobby.winnerId && (
            <div className="guess-wrapper">
              <form className="guess-form" onSubmit={handleGuess}>
                <input
                  value={guess}
                  onChange={(e) => setGuess(e.target.value)}
                  placeholder={`Введите слово из ${lobby.wordLength} букв`}
                  maxLength={lobby.wordLength}
                  className="guess-input"
                  autoFocus
                  disabled={attemptsUsed >= lobby.attemptsLimit}
                />
                <button
                  type="submit"
                  className="primary"
                  disabled={attemptsUsed >= lobby.attemptsLimit}
                >
                  Отправить
                </button>
              </form>
            </div>
          )}

          {message && started && (
            <div className="flash">
              {message}
            </div>
          )}

          {!lobby.winnerId && (
            <div className="keyboard">
              {["йцукенгшщзхъ", "фывапролджэ", "ячсмитьбю"].map((row) => (
                <div className="kb-row" key={row}>
                  {row.split("").map((letter) => {
                    const state = letterStates[letter] || "idle";
                    return (
                      <button
                        key={letter}
                        type="button"
                        className={`kb-key ${state}`}
                        onClick={() => setGuess((g) => (g + letter).slice(0, lobby.wordLength))}
                        disabled={attemptsUsed >= lobby.attemptsLimit}
                      >
                        {letter.toUpperCase()}
                      </button>
                    );
                  })}
                  {row === "ячсмитьбю" && (
                    <>
                      <button
                        type="button"
                        className="kb-key wide"
                        onClick={() => setGuess("")}
                        disabled={attemptsUsed >= lobby.attemptsLimit}
                      >
                        Стереть
                      </button>
                      <button
                        type="button"
                        className="kb-key wide primary"
                        onClick={(e) => handleGuess(e)}
                        disabled={attemptsUsed >= lobby.attemptsLimit}
                      >
                        Ввод
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {attemptsUsed >= lobby.attemptsLimit && !lobby.winnerId && (
            <div className="flash danger">
              Попытки закончились — вы проиграли этот раунд. Подождите рестарта от хоста.
            </div>
          )}

          {lobby.winnerId && (
            <div className="flash success">
              Победитель:{" "}
              {playersWithGuesses.find((p) => p.id === lobby.winnerId)?.name ||
                "Неизвестно"}
              {isHost && (
                <button className="primary inline-btn" onClick={handleRestart}>
                  Новая игра
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export default App;
