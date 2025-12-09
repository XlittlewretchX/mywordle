import { useEffect, useMemo, useState } from "react";
import "./App.css";

const API_URL_RAW = import.meta.env.VITE_API_URL || "http://localhost:8000";
const API_URL = API_URL_RAW.replace(/\/+$/, "");
const WS_URL_RAW = import.meta.env.VITE_WS_URL || API_URL.replace(/^http/, "ws");
const WS_URL = WS_URL_RAW.replace(/\/+$/, "");
const SESSION_KEY = "wordle_session";
const THEME_KEY = "mywordle_theme";

const initialLobby = null;

const Toast = ({ title, text, sub, type = "info", onClose }) => (
  <div className={`toast ${type}`}>
    <div className="toast-icon">{type === "success" ? "✓" : type === "error" ? "!" : "i"}</div>
    <div className="toast-body">
      <div className="toast-title">{title}</div>
      {text && <div className="toast-text">{text}</div>}
      {sub && <div className="toast-sub">{sub}</div>}
    </div>
    <button className="toast-close" onClick={onClose} aria-label="Закрыть уведомление">
      ×
    </button>
    <div className="toast-progress" />
  </div>
);

function App() {
  const [playerName, setPlayerName] = useState("");
  const [wordLength, setWordLength] = useState(5);
  const [attemptsLimit, setAttemptsLimit] = useState(6);
  const [timedMode, setTimedMode] = useState(false);
  const [roundSeconds, setRoundSeconds] = useState(180);
  const autoAdvance = true;
  const [teamMode, setTeamMode] = useState(false);
  const [availableLengths, setAvailableLengths] = useState([]);
  const [lobbyCode, setLobbyCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [lobby, setLobby] = useState(initialLobby);
  const [toasts, setToasts] = useState([]);
  const [guess, setGuess] = useState("");
  const [wsStatus, setWsStatus] = useState("disconnected");
  const [wsNonce, setWsNonce] = useState(0);
  const [nowTs, setNowTs] = useState(Date.now());
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

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

  const stampLobby = (state) => (state ? { ...state, _receivedAt: Date.now() } : state);

  useEffect(() => {
    document.documentElement.classList.toggle("theme-dark", theme === "dark");
    document.documentElement.classList.toggle("theme-light", theme === "light");
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    // авто-восстановление сессии после перезагрузки
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.code || !parsed.playerId) return;
      postJson(`/lobby/${parsed.code}/reconnect`, {
        player_id: parsed.playerId,
        player_name: parsed.playerName || "Игрок",
      })
        .then((state) => {
          setPlayerId(parsed.playerId);
          setPlayerName(parsed.playerName || "");
          setLobby(stampLobby(state));
          setLobbyCode(parsed.code);
          setJoinCode(parsed.code);
        })
        .catch(() => {
          localStorage.removeItem(SESSION_KEY);
        });
    } catch (e) {
      localStorage.removeItem(SESSION_KEY);
    }
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
          setLobby(stampLobby(state));
        }
      } catch (err) {
        console.error("Bad WS message", err);
      }
    };

    return () => ws.close();
  }, [lobby?.code, playerId, wsNonce]);

  useEffect(() => {
    if (!lobby?.timedMode) return undefined;
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [lobby?.timedMode, lobby?._receivedAt]);

  const removeToast = (id) => setToasts((prev) => prev.filter((t) => t.id !== id));

  const pushToast = (title, text, type = "info", sub = "") => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, title, text, type, sub }]);
    setTimeout(() => removeToast(id), 5000);
  };

  const notify = (text) => {
    pushToast("Сообщение", text, "info");
  };

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
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
        timed_mode: timedMode,
        round_seconds: roundSeconds,
        auto_advance: autoAdvance,
        team_mode: teamMode,
      });
      setPlayerId(data.playerId);
      setLobby(stampLobby(data.lobby));
      setLobbyCode(data.lobby.code);
      setJoinCode(data.lobby.code);
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ code: data.lobby.code, playerId: data.playerId, playerName: playerName.trim() }),
      );
      pushToast("Лобби создано", `Код: ${data.lobby.code}`, "success");
    } catch (error) {
      pushToast("Ошибка", error.message, "error");
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
      setLobby(stampLobby(data.lobby));
      setLobbyCode(code);
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ code, playerId: data.playerId, playerName: playerName.trim() }),
      );
      pushToast("Готово", "Присоединились к лобби", "success");
    } catch (error) {
      pushToast("Ошибка", error.message, "error");
    }
  };

  const handleStart = async () => {
    try {
      const data = await postJson(`/lobby/${lobby.code}/start`, { player_id: playerId });
      setLobby(stampLobby(data));
    } catch (error) {
      pushToast("Ошибка", error.message, "error");
    }
  };

  const handleRestart = async () => {
    try {
      const data = await postJson(`/lobby/${lobby.code}/restart`, { player_id: playerId });
      setLobby(stampLobby(data));
      setGuess("");
    } catch (error) {
      pushToast("Ошибка", error.message, "error");
    }
  };

  const resetClientState = () => {
    setLobby(initialLobby);
    setPlayerId("");
    setLobbyCode("");
    setJoinCode("");
    setGuess("");
    localStorage.removeItem(SESSION_KEY);
  };

  const handleLeave = async () => {
    if (!lobby) return;
    try {
      await postJson(`/lobby/${lobby.code}/leave`, { player_id: playerId });
      resetClientState();
      pushToast("Вы покинули лобби", "", "info");
    } catch (error) {
      pushToast("Ошибка", error.message, "error");
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

  const handleTeamChange = async (targetId, team) => {
    try {
      const data = await postJson(`/lobby/${lobby.code}/team`, {
        player_id: playerId,
        target_id: targetId,
        team,
      });
      setLobby(stampLobby(data));
    } catch (error) {
      pushToast("Ошибка", error.message, "error");
    }
  };

  const handleDeleteLobby = async () => {
    if (!lobby) return;
    try {
      await postJson(`/lobby/${lobby.code}/delete`, { player_id: playerId });
      resetClientState();
      pushToast("Лобби удалено", "", "info");
    } catch (error) {
      pushToast("Ошибка", error.message, "error");
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
      const res = await postJson(`/lobby/${lobby.code}/guess`, {
        player_id: playerId,
        guess: guess.trim().toLowerCase(),
      });
      setGuess("");
      if (lobby?.timedMode && res?.guess?.feedback?.every((f) => f === "correct")) {
        pushToast(
          "Слово угадано!",
          `Вы угадали ${res.guess.word.toUpperCase()}`,
          "success",
          "Новое слово уже ждёт, продолжай.",
        );
      }
    } catch (error) {
      pushToast("Ошибка", error.message, "error");
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
    const priority = { correct: 3, present: 2, absent: 1, idle: 0 };
    const sourcePlayers =
      lobby?.teamMode && you
        ? playersWithGuesses.filter((p) => p.team === you.team)
        : you
        ? [you]
        : [];
    sourcePlayers.forEach((pl) =>
      pl.guesses?.forEach((g) =>
        g.feedback.forEach((state, idx) => {
          const letter = g.word[idx];
          const prev = map[letter];
          if (!prev || priority[state] > priority[prev]) {
            map[letter] = state;
          }
        }),
      ),
    );
    return map;
  }, [lobby?.teamMode, playersWithGuesses, you]);

  const roundRemainingSec = useMemo(() => {
    if (!lobby?.timedMode) return null;
    const base = lobby.roundRemainingSeconds;
    if (base === undefined || base === null) return null;
    const elapsed = lobby._receivedAt ? Math.floor((nowTs - lobby._receivedAt) / 1000) : 0;
    return Math.max(0, base - elapsed);
  }, [lobby?.timedMode, lobby?.roundRemainingSeconds, lobby?._receivedAt, nowTs]);

  const timedFinished = lobby?.timedFinished || (lobby?.timedMode && roundRemainingSec === 0);
  const noWinnerFinished = lobby?.noWinnerFinished;
  const failedWord = lobby?.failedWord;
  const canGuess = started && !timedFinished && !lobby?.winnerId && !noWinnerFinished;
  const scoreboard = useMemo(() => {
    if (!lobby?.scores) return [];
    return playersWithGuesses
      .map((p) => ({ ...p, score: lobby.scores[p.id] ?? 0 }))
      .sort((a, b) => b.score - a.score);
  }, [lobby?.scores, playersWithGuesses]);

  const teamTotals = useMemo(() => {
    if (!lobby?.teamScores) return null;
    return [
      { id: "A", score: lobby.teamScores["A"] ?? 0 },
      { id: "B", score: lobby.teamScores["B"] ?? 0 },
    ];
  }, [lobby?.teamScores]);

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
      {toasts.length > 0 && (
        <div className="toast-layer">
          {toasts.map((t) => (
            <Toast
              key={t.id}
              title={t.title}
              text={t.text}
              sub={t.sub}
              type={t.type}
              onClose={() => removeToast(t.id)}
            />
          ))}
        </div>
      )}
      <header className="topbar hero">
        <div className="hero-text">
          <p className="eyebrow">Русский мультиплеер до 4 игроков</p>
          <h1>MyWordle</h1>
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
            {lobby?.timedMode && roundRemainingSec !== null && (
              <span className="chip chip-timer">
                Таймер: {Math.floor((roundRemainingSec || 0) / 60)}:
                {String((roundRemainingSec || 0) % 60).padStart(2, "0")}
              </span>
            )}
            <button className="ghost theme-toggle" onClick={toggleTheme} aria-label="Переключить тему">
              {theme === "dark" ? "🌙 Тёмная тема" : "☀️ Светлая тема"}
            </button>
          </div>
        </div>
      </header>

      {!lobby && (
        <>
          <section className="card name-card stack">
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

          <section className="card setup-card">
            <div className="setup-header">
      <div>
                <h2>Настройки лобби</h2>
                <p className="muted">Выберите режим и параметры, затем создайте лобби или введите код.</p>
              </div>
            </div>

            <div className="mode-switch">
              <button
                type="button"
                className={`pill-btn ${!timedMode ? "active" : ""}`}
                onClick={() => setTimedMode(false)}
              >
                Классический режим
              </button>
              <button
                type="button"
                className={`pill-btn ${timedMode ? "active" : ""}`}
                onClick={() => setTimedMode(true)}
              >
                Гонка на время
              </button>
            </div>

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

              {timedMode && (
                <label>
                  Время раунда (мин)
                  <select
                    value={Math.round(roundSeconds / 60)}
                    onChange={(e) => setRoundSeconds(Number(e.target.value) * 60)}
                  >
                    {[1, 2, 3, 4, 5].map((m) => (
                      <option key={m} value={m}>
                        {m} мин
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            <label className="toggle">
              <input
                type="checkbox"
                checked={teamMode}
                onChange={(e) => setTeamMode(e.target.checked)}
              />
              Командный режим
            </label>

            <div className="form-actions">
              <button className="primary" onClick={handleCreate} disabled={!playerName.trim()}>
                Создать лобби
              </button>
              {lobbyCode && (
                <div className="hint">
                  Код лобби: <strong>{lobbyCode}</strong>
                </div>
              )}
      </div>

            <div className="join-row">
              <label className="full">
                Войти по коду
                <div className="join-inline">
                  <input
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    placeholder="ABCDE"
                  />
                  <button onClick={handleJoin} disabled={!playerName.trim()}>
                    Подключиться
        </button>
                </div>
              </label>
            </div>
          </section>
        </>
      )}

      {lobby && (
        <section className="card">
          <header className="lobby-head">
            <div>
              <h3>Лобби {lobby.code}</h3>
              <p>Длина слова: {lobby.wordLength}</p>
              <p>Лимит попыток: {lobby.attemptsLimit}</p>
              <p>Статус: {lobby.started ? "Идет игра" : "Ждем начала"}</p>
              {lobby.timedMode && (
                <p className="muted">
                  Таймер: {Math.floor((roundRemainingSec || 0) / 60)}:
                  {String((roundRemainingSec || 0) % 60).padStart(2, "0")} • Авто-переход:{" "}
                  {lobby.autoAdvance ? "вкл" : "выкл"}
                </p>
              )}
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

          <div className="players compact">
            {playersWithGuesses.map((p) => (
              <div className="player-card" key={p.id}>
                <div className="card-top">
                  <div className="player-info">
                    <strong>{p.name}</strong>
                    {p.id === lobby.hostId && <span className="badge">Хост</span>}
                    {p.id === playerId && <span className="badge you">Вы</span>}
                    {lobby.teamMode && (
                      <span className={`badge team ${p.team === "A" ? "team-a" : "team-b"}`}>{p.team}</span>
                    )}
                  </div>
                  {lobby.winnerId === p.id && <span className="winner">Угадал слово!</span>}
                </div>
                {isHost && p.id !== lobby.hostId && (
                  <div className="card-bottom">
                    {lobby.teamMode && (
                      <div className="team-switch">
                        <button
                          type="button"
                          className={`mini-pill ${p.team === "A" ? "active" : ""}`}
                          onClick={() => handleTeamChange(p.id, "A")}
                        >
                          A
                        </button>
                        <button
                          type="button"
                          className={`mini-pill ${p.team === "B" ? "active" : ""}`}
                          onClick={() => handleTeamChange(p.id, "B")}
                        >
                          B
                        </button>
                      </div>
                    )}
                    <button className="ghost danger mini" onClick={() => handleKick(p.id)}>
                      Удалить
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {lobby && started && !timedFinished && (
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
            {lobby.timedMode && roundRemainingSec !== null && (
              <span className="chip chip-timer">
                Осталось: {Math.floor((roundRemainingSec || 0) / 60)}:
                {String((roundRemainingSec || 0) % 60).padStart(2, "0")}
              </span>
            )}
          </div>
          <div className="board">
            {lobby.teamMode && you
              ? playersWithGuesses
                  .filter((p) => p.team === you.team)
                  .flatMap((p) =>
                    p.guesses.map((g, idx) => ({
                      ...g,
                      key: `${g.word}-${p.id}-${g.order ?? idx}`,
                      owner: p.name,
                      isYou: p.id === you.id,
                      order: g.order ?? idx,
                    })),
                  )
                  .sort((a, b) => a.order - b.order)
                  .map((entry) => (
                    <div className="guess-row-wrapper" key={entry.key}>
                      <div className="guess-owner">
                        {entry.owner} {entry.isYou && <span className="badge you">Вы</span>}
                      </div>
                      {renderGuessRow(entry)}
                    </div>
                  ))
              : you?.guesses?.length
              ? you.guesses.map(renderGuessRow)
              : <p className="hint">Пока нет попыток — введите первое слово.</p>}
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

          {canGuess && (
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

          {lobby.winnerId && lobby.winnerWord && (
            <div className="flash success">
              Слово раунда: {lobby.winnerWord.toUpperCase()}
            </div>
          )}

          {attemptsUsed >= lobby.attemptsLimit && !lobby.winnerId && !timedFinished && (
            <div className="flash danger">
              Попытки закончились — вы проиграли этот раунд. Подождите рестарта от хоста.
            </div>
          )}

          {lobby.winnerId && (
            <div className="flash success">
              {lobby.teamMode ? (
                <>
                  Победила команда{" "}
                  <strong>
                    {playersWithGuesses.find((p) => p.id === lobby.winnerId)?.team || "?"}
                  </strong>
                  :{" "}
                  {playersWithGuesses
                    .filter(
                      (p) =>
                        p.team ===
                        (playersWithGuesses.find((pl) => pl.id === lobby.winnerId)?.team || ""),
                    )
                    .map((p) => p.name)
                    .join(", ")}
                </>
              ) : (
                <>
                  Победитель:{" "}
                  {playersWithGuesses.find((p) => p.id === lobby.winnerId)?.name || "Неизвестно"}
                </>
              )}
              {lobby.winnerWord && (
                <span className="winner-word"> — слово: {lobby.winnerWord.toUpperCase()}</span>
              )}
              {isHost && (
                <button className="primary inline-btn" onClick={handleRestart}>
                  Новая игра
                </button>
              )}
            </div>
          )}

          {noWinnerFinished && (
            <div className="flash danger">
              Попытки закончились у всех. Никто не угадал.
              {failedWord && (
                <span className="winner-word"> Слово было: {failedWord.toUpperCase()}</span>
              )}
              {isHost && (
                <button className="primary inline-btn" onClick={handleRestart}>
                  Перезапустить игру
                </button>
              )}
            </div>
          )}

        </section>
      )}

      {lobby?.timedMode && timedFinished && (
        <section className="card score-card">
          <div className="score-board">
            <div className="score-board-head">
              <div>
                <h4>Итоги раунда</h4>
                {!lobby.timedMode && lobby.lastSolvedWord && (
                  <p className="muted">Слово раунда: {lobby.lastSolvedWord.toUpperCase()}</p>
                )}
                {lobby.timedMode && lobby.wordSequence?.length ? (
                  <div className="word-seq">
                    <span className="muted">Слова раунда:</span>
                    <div className="word-chip-row">
                      {lobby.wordSequence.map((w, idx) => (
                        <span className="word-chip" key={`${w}-${idx}`}>
                          {idx + 1}. {w.toUpperCase()}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
              {lobby.teamMode && teamTotals && (
                <div className="team-totals">
                  <span className="chip chip-team-a">Команда A: {teamTotals[0].score}</span>
                  <span className="chip chip-team-b">Команда B: {teamTotals[1].score}</span>
                </div>
              )}
            </div>
            <div className="score-table">
              <div className="score-row head">
                <span>Игрок</span>
                <span>Очки</span>
                {lobby.teamMode && <span>Команда</span>}
              </div>
              {scoreboard.map((p, idx) => (
                <div key={p.id} className="score-row">
                  <div className="player-info">
                    <span className="score-rank">{idx + 1}</span>
                    <span className="score-name">{p.name}</span>
                  </div>
                  <div className="score-meta">
                    <span className="score-value">{p.score} очк.</span>
                    {idx === 0 && <span className="chip chip-live">MVP</span>}
                  </div>
                  {lobby.teamMode && (
                    <div className="team-cell">
                      <span className={`badge team ${p.team === "A" ? "team-a" : "team-b"}`}>{p.team}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
            {isHost && (
              <div className="form-actions">
                <button className="primary full" onClick={handleRestart}>
                  Перезапустить игру
                </button>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

export default App;
