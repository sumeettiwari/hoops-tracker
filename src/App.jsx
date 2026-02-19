import { useState, useEffect, useCallback } from "react";
import React from "react";
import { supabase } from "./supabase";
import Login from "./Login";

// ─── helpers ─────────────────────────────────────────────────────────────────

const emptyStats = () => ({ pts2: 0, pts3: 0, fgm: 0, fga: 0, reb: 0, ast: 0, stl: 0, to: 0 });
const pts     = (s) => (s.pts2 || 0) * 2 + (s.pts3 || 0) * 3;
const fgpct   = (s) => s.fga > 0 ? ((s.fgm / s.fga) * 100).toFixed(0) + "%" : "—";
const winpct  = (w, l) => (w + l) === 0 ? "—" : ((w / (w + l)) * 100).toFixed(0) + "%";
const addStats = (a, b) => {
  const r = emptyStats();
  Object.keys(r).forEach((k) => { r[k] = (a[k] || 0) + (b[k] || 0); });
  return r;
};

const playerTeam = (game, pid) => {
  if (game.teams.a.includes(pid)) return "a";
  if (game.teams.b.includes(pid)) return "b";
  return null;
};
const playerWon = (game, pid) => {
  if (!game.winner) return null;
  const team = playerTeam(game, pid);
  if (!team) return null;
  return team === game.winner;
};

const STAT_BTNS = [
  { key: "pts2", label: "2-PT" }, { key: "pts3", label: "3-PT" },
  { key: "fgm",  label: "FGM"  }, { key: "fga",  label: "FGA"  },
  { key: "reb",  label: "REB"  }, { key: "ast",  label: "AST"  },
  { key: "stl",  label: "STL"  }, { key: "to",   label: "TO"   },
];

// ─── data shape helpers ───────────────────────────────────────────────────────
// The app works with "night" objects shaped like:
// { id, date, youtubeUrl, players:[id], games:[{ id, number, winner, teams:{a:[id],b:[id]}, stats:{pid: statObj} }] }
// These functions convert between that shape and Supabase rows.

function mergePlayerStats(night) {
  const out = {};
  night.games.forEach((g) => {
    const hasTeams = g.teams.a.length > 0 || g.teams.b.length > 0;
    Object.entries(g.stats).forEach(([pid, s]) => {
      const onTeam = g.teams.a.includes(pid) || g.teams.b.includes(pid);
      if (!hasTeams || onTeam) {
        out[pid] = out[pid] ? addStats(out[pid], s) : { ...s };
      }
    });
  });
  return out;
}

function seasonStats(players, nights) {
  const out = {};
  players.forEach((p) => { out[p.id] = { totals: emptyStats(), gp: 0, nights: 0, w: 0, l: 0 }; });
  nights.forEach((night) => {
    const seen = new Set();
    night.games.forEach((g) => {
      const hasTeams = g.teams.a.length > 0 || g.teams.b.length > 0;
      Object.keys(g.stats).forEach((pid) => {
        if (!out[pid]) return;
        const onTeam = g.teams.a.includes(pid) || g.teams.b.includes(pid);
        if (!hasTeams || onTeam) {
          out[pid].gp += 1;
          if (!seen.has(pid)) seen.add(pid);
          out[pid].totals = addStats(out[pid].totals, g.stats[pid]);
        }
        const won = playerWon(g, pid);
        if (won === true)  out[pid].w += 1;
        if (won === false) out[pid].l += 1;
      });
    });
    seen.forEach((pid) => { if (out[pid]) out[pid].nights += 1; });
  });
  return out;
}

// ─── Supabase data layer ──────────────────────────────────────────────────────

async function fetchPlayers() {
  const { data, error } = await supabase
    .from("players")
    .select("id, name")
    .order("name");
  if (error) throw error;
  return data;
}

async function fetchNights() {
  // Fetch all nights with their games, game_players, and player_stats in one go
  const { data: nightRows, error: nightErr } = await supabase
    .from("nights")
    .select("id, date, youtube_url")
    .order("date", { ascending: false });
  if (nightErr) throw nightErr;

  const { data: npRows, error: npErr } = await supabase
    .from("night_players")
    .select("night_id, player_id");
  if (npErr) throw npErr;

  const { data: gameRows, error: gameErr } = await supabase
    .from("games")
    .select("id, night_id, number, winner")
    .order("number");
  if (gameErr) throw gameErr;

  const { data: gpRows, error: gpErr } = await supabase
    .from("game_players")
    .select("game_id, player_id, team");
  if (gpErr) throw gpErr;

  const { data: statRows, error: statErr } = await supabase
    .from("player_stats")
    .select("game_id, player_id, pts2, pts3, fgm, fga, reb, ast, stl, to_");
  if (statErr) throw statErr;

  // Assemble into the shape the app expects
  return nightRows.map((n) => {
    const nightPlayerIds = npRows
      .filter((r) => r.night_id === n.id)
      .map((r) => r.player_id);

    const games = gameRows
      .filter((g) => g.night_id === n.id)
      .map((g) => {
        const teamA = gpRows.filter((r) => r.game_id === g.id && r.team === "a").map((r) => r.player_id);
        const teamB = gpRows.filter((r) => r.game_id === g.id && r.team === "b").map((r) => r.player_id);
        const stats = {};
        statRows.filter((r) => r.game_id === g.id).forEach((r) => {
          stats[r.player_id] = {
            pts2: r.pts2 || 0, pts3: r.pts3 || 0,
            fgm:  r.fgm  || 0, fga:  r.fga  || 0,
            reb:  r.reb  || 0, ast:  r.ast  || 0,
            stl:  r.stl  || 0, to:   r.to_  || 0,
          };
        });
        // Init stats for any night players not yet in stats
        nightPlayerIds.forEach((pid) => { if (!stats[pid]) stats[pid] = emptyStats(); });
        return { id: g.id, number: g.number, winner: g.winner, teams: { a: teamA, b: teamB }, stats };
      });

    return { id: n.id, date: n.date, youtubeUrl: n.youtube_url || "", players: nightPlayerIds, games };
  });
}

async function dbAddPlayer(name) {
  const { data, error } = await supabase
    .from("players")
    .insert({ name })
    .select("id, name")
    .single();
  if (error) throw error;
  return data;
}

async function dbDeletePlayer(id) {
  const { error } = await supabase.from("players").delete().eq("id", id);
  if (error) throw error;
}

async function dbCreateNight(date, youtubeUrl, playerIds) {
  const { data: night, error: ne } = await supabase
    .from("nights")
    .insert({ date, youtube_url: youtubeUrl || null })
    .select("id, date, youtube_url")
    .single();
  if (ne) throw ne;

  if (playerIds.length > 0) {
    const { error: npe } = await supabase
      .from("night_players")
      .insert(playerIds.map((pid) => ({ night_id: night.id, player_id: pid })));
    if (npe) throw npe;
  }
  return { id: night.id, date: night.date, youtubeUrl: night.youtube_url || "", players: playerIds, games: [] };
}

async function dbDeleteNight(id) {
  // Cascade deletes handle games, game_players, player_stats
  const { error } = await supabase.from("nights").delete().eq("id", id);
  if (error) throw error;
}

async function dbCreateGame(nightId, gameNumber, teamA, teamB, playerIds) {
  const { data: game, error: ge } = await supabase
    .from("games")
    .insert({ night_id: nightId, number: gameNumber, winner: null })
    .select("id, number, winner")
    .single();
  if (ge) throw ge;

  // Insert game_players for all assigned team members
  const gpInserts = [
    ...teamA.map((pid) => ({ game_id: game.id, player_id: pid, team: "a" })),
    ...teamB.map((pid) => ({ game_id: game.id, player_id: pid, team: "b" })),
  ];
  // Players with no team assignment still get a game_players row (team: null)
  const assigned = new Set([...teamA, ...teamB]);
  playerIds.forEach((pid) => {
    if (!assigned.has(pid)) gpInserts.push({ game_id: game.id, player_id: pid, team: null });
  });
  if (gpInserts.length > 0) {
    const { error: gpe } = await supabase.from("game_players").insert(gpInserts);
    if (gpe) throw gpe;
  }

  // Init empty stats for all night players
  if (playerIds.length > 0) {
    const { error: se } = await supabase
      .from("player_stats")
      .insert(playerIds.map((pid) => ({
        game_id: game.id, player_id: pid,
        pts2: 0, pts3: 0, fgm: 0, fga: 0, reb: 0, ast: 0, stl: 0, to_: 0,
      })));
    if (se) throw se;
  }

  const stats = {};
  playerIds.forEach((pid) => { stats[pid] = emptyStats(); });
  return { id: game.id, number: game.number, winner: null, teams: { a: teamA, b: teamB }, stats };
}

async function dbDeleteGame(gameId) {
  const { error } = await supabase.from("games").delete().eq("id", gameId);
  if (error) throw error;
}

async function dbUpdateStat(gameId, playerId, statObj) {
  const { error } = await supabase
    .from("player_stats")
    .upsert({
      game_id: gameId, player_id: playerId,
      pts2: statObj.pts2, pts3: statObj.pts3,
      fgm: statObj.fgm, fga: statObj.fga,
      reb: statObj.reb, ast: statObj.ast,
      stl: statObj.stl, to_: statObj.to,
    });
  if (error) throw error;
}

async function dbSetWinner(gameId, winner) {
  const { error } = await supabase
    .from("games")
    .update({ winner })
    .eq("id", gameId);
  if (error) throw error;
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [session,      setSession]      = useState(undefined); // undefined = loading, null = logged out
  const [isAdmin,      setIsAdmin]      = useState(false);
  const [players,      setPlayers]      = useState([]);
  const [nights,       setNights]       = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [view,         setView]         = useState("roster");
  const [activeNight,  setActiveNight]  = useState(null);
  const [activeGame,   setActiveGame]   = useState(null);
  const [activePid,    setActivePid]    = useState(null);
  const [notif,        setNotif]        = useState(null);
  const [saving,       setSaving]       = useState(false);
  const [newName,      setNewName]      = useState("");
  const [nightDate,    setNightDate]    = useState("");
  const [nightUrl,     setNightUrl]     = useState("");
  const [nightPlayers, setNightPlayers] = useState(new Set());
  const [teamSetup,    setTeamSetup]    = useState(false);
  const [teamA,        setTeamA]        = useState(new Set());
  const [teamB,        setTeamB]        = useState(new Set());
  const [trackMode,    setTrackMode]    = useState("grid");

  // ── auth ──
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setIsAdmin(!!session);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      setSession(session);
      setIsAdmin(!!session);
    });
    return () => subscription.unsubscribe();
  }, []);

  // ── initial data load ──
  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [p, n] = await Promise.all([fetchPlayers(), fetchNights()]);
      setPlayers(p);
      setNights(n);
    } catch (e) {
      notify("Failed to load data: " + e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (session !== undefined) loadAll();
  }, [session, loadAll]);

  const notify = (msg) => { setNotif(msg); setTimeout(() => setNotif(null), 2500); };
  const wrap = async (fn, successMsg) => {
    setSaving(true);
    try { await fn(); if (successMsg) notify(successMsg); }
    catch (e) { notify("Error: " + e.message); }
    setSaving(false);
  };

  const sortedPlayers = [...players].sort((a, b) => a.name.localeCompare(b.name));

  // ── roster ──
  const addPlayer = () => wrap(async () => {
    const name = newName.trim();
    if (!name) return;
    if (players.find((p) => p.name.toLowerCase() === name.toLowerCase())) { notify("Already exists"); return; }
    const p = await dbAddPlayer(name);
    setPlayers((prev) => [...prev, p].sort((a, b) => a.name.localeCompare(b.name)));
    setNewName("");
  });

  const removePlayer = (id) => wrap(async () => {
    await dbDeletePlayer(id);
    setPlayers((prev) => prev.filter((p) => p.id !== id));
  }, "Player removed");

  // ── night ──
  const startNight = () => wrap(async () => {
    if (nightPlayers.size < 2) { notify("Select at least 2 players"); return; }
    const night = await dbCreateNight(
      nightDate || new Date().toISOString().split("T")[0],
      nightUrl.trim(),
      [...nightPlayers]
    );
    setNights((prev) => [night, ...prev]);
    setActiveNight(night);
    setNightDate(""); setNightUrl(""); setNightPlayers(new Set());
    setActiveGame(null); setActivePid(null); setView("night");
  });

  const resumeNight = (night) => {
    setActiveNight({ ...night });
    setActiveGame(night.games.length > 0 ? night.games.length - 1 : null);
    setActivePid(players.find((p) => night.players.includes(p.id))?.id || null);
    setView("night");
  };

  // Save = just sync the night back to the nights list and exit tracking view
  const saveNight = () => {
    if (!activeNight) return;
    setNights((prev) => {
      const i = prev.findIndex((n) => n.id === activeNight.id);
      if (i >= 0) { const u = [...prev]; u[i] = activeNight; return u; }
      return [activeNight, ...prev];
    });
    setActiveNight(null); setActiveGame(null); setActivePid(null);
    setView("stats"); notify("Night saved!");
  };

  const deleteNight = (id) => wrap(async () => {
    await dbDeleteNight(id);
    setNights((prev) => prev.filter((n) => n.id !== id));
  }, "Night deleted");

  // ── game ──
  const openTeamSetup = () => { setTeamA(new Set()); setTeamB(new Set()); setTeamSetup(true); };

  const startGame = () => wrap(async () => {
    const game = await dbCreateGame(
      activeNight.id,
      activeNight.games.length + 1,
      [...teamA], [...teamB],
      activeNight.players
    );
    const updated = { ...activeNight, games: [...activeNight.games, game] };
    setActiveNight(updated);
    setNights((prev) => prev.map((n) => n.id === updated.id ? updated : n));
    setActiveGame(updated.games.length - 1);
    setActivePid(players.find((p) => activeNight.players.includes(p.id))?.id || null);
    setTeamSetup(false); setTeamA(new Set()); setTeamB(new Set());
  });

  const deleteGame = (idx) => wrap(async () => {
    const game = activeNight.games[idx];
    await dbDeleteGame(game.id);
    const games = activeNight.games
      .filter((_, i) => i !== idx)
      .map((g, i) => ({ ...g, number: i + 1 }));
    // Renumber in DB
    await Promise.all(games.map((g) =>
      supabase.from("games").update({ number: g.number }).eq("id", g.id)
    ));
    const updated = { ...activeNight, games };
    setActiveNight(updated);
    setNights((prev) => prev.map((n) => n.id === updated.id ? updated : n));
    if (activeGame >= idx) setActiveGame(Math.max(0, (activeGame || 0) - 1));
  }, "Game removed");

  // logStat — update local state immediately (optimistic), then persist
  const logStat = (pid, key, delta = 1) => {
    let newStats;
    setActiveNight((n) => {
      const games = [...n.games];
      const g = { ...games[activeGame], stats: { ...games[activeGame].stats } };
      const s = { ...g.stats[pid] };
      s[key] = Math.max(0, (s[key] || 0) + delta);
      if (key === "pts2" || key === "pts3") {
        s.fga = Math.max(0, (s.fga || 0) + delta);
        s.fgm = Math.max(0, (s.fgm || 0) + delta);
      }
      g.stats[pid] = s;
      newStats = s;
      games[activeGame] = g;
      return { ...n, games };
    });
    // Persist after state update — small debounce via setTimeout
    setTimeout(() => {
      if (newStats && activeNight) {
        const gameId = activeNight.games[activeGame]?.id;
        if (gameId) dbUpdateStat(gameId, pid, newStats).catch((e) => notify("Save error: " + e.message));
      }
    }, 0);
  };

  const setWinner = (gameIdx, winner) => wrap(async () => {
    const game = activeNight.games[gameIdx];
    const newWinner = game.winner === winner ? null : winner;
    await dbSetWinner(game.id, newWinner);
    setActiveNight((n) => {
      const games = [...n.games];
      games[gameIdx] = { ...games[gameIdx], winner: newWinner };
      return { ...n, games };
    });
  });

  const setWinnerSaved = (nightId, gameIdx, winner) => wrap(async () => {
    const night = nights.find((n) => n.id === nightId);
    if (!night) return;
    const game = night.games[gameIdx];
    const newWinner = game.winner === winner ? null : winner;
    await dbSetWinner(game.id, newWinner);
    setNights((prev) => prev.map((n) => {
      if (n.id !== nightId) return n;
      const games = [...n.games];
      games[gameIdx] = { ...games[gameIdx], winner: newWinner };
      return { ...n, games };
    }));
  });

  const handleLogout = async () => {
    await supabase.auth.signOut();
    notify("Signed out");
  };

  // ── derived ──
  const curGame          = activeNight && activeGame !== null ? activeNight.games[activeGame] : null;
  const curStats         = curGame?.stats[activePid] || emptyStats();
  const nightGamePlayers = activeNight ? players.filter((p) => activeNight.players.includes(p.id)) : [];
  const curGamePlayers   = curGame
    ? players.filter((p) => curGame.teams.a.includes(p.id) || curGame.teams.b.includes(p.id) || (curGame.teams.a.length === 0 && activeNight.players.includes(p.id)))
    : [];
  const nightTotals  = activeNight ? mergePlayerStats(activeNight) : {};
  const seasonData   = seasonStats(players, nights);
  const sortedSeason = [...players].sort((a, b) => pts(seasonData[b.id]?.totals || emptyStats()) - pts(seasonData[a.id]?.totals || emptyStats()));
  const hasTeams     = (g) => g && (g.teams.a.length > 0 || g.teams.b.length > 0);

  // ── loading / auth gates ──
  if (session === undefined) return (
    <div style={{ minHeight: "100vh", background: "#0a0c0f", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 20, letterSpacing: 4, color: "#333" }}>LOADING...</div>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#0a0c0f", color: "#e8e4d9", fontFamily: "'Bebas Neue', sans-serif", position: "relative" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0a0c0f; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: #111; } ::-webkit-scrollbar-thumb { background: #f97316; border-radius: 2px; }
        button { cursor: pointer; border: none; outline: none; } input { outline: none; }

        .stat-btn { background: #1a1d22; border: 1px solid #2a2d35; color: #e8e4d9; padding: 10px 6px; border-radius: 6px; font-family: 'DM Mono', monospace; font-size: 11px; transition: all 0.15s; display: flex; flex-direction: column; align-items: center; gap: 3px; width: 100%; }
        .stat-btn:hover { background: #f97316; border-color: #f97316; color: #000; transform: scale(1.04); }
        .stat-btn:active { transform: scale(0.96); }
        .stat-btn .val { font-size: 22px; font-family: 'Bebas Neue', sans-serif; line-height: 1; }

        .player-chip { padding: 7px 13px; border-radius: 4px; font-family: 'Bebas Neue', sans-serif; font-size: 14px; letter-spacing: 1px; transition: all 0.15s; border: 1.5px solid #2a2d35; background: transparent; color: #888; white-space: nowrap; }
        .player-chip.active { background: #f97316; border-color: #f97316; color: #000; }
        .player-chip:hover:not(.active) { border-color: #f97316; color: #f97316; }

        .game-tab { padding: 7px 14px; border-radius: 4px; font-family: 'Bebas Neue', sans-serif; font-size: 13px; letter-spacing: 1px; transition: all 0.15s; border: 1.5px solid #2a2d35; background: transparent; color: #666; white-space: nowrap; position: relative; }
        .game-tab.active { border-color: #f97316; color: #f97316; background: rgba(249,115,22,0.08); }
        .game-tab:hover:not(.active) { border-color: #444; color: #aaa; }
        .game-tab .win-dot { position: absolute; top: -4px; right: -4px; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid #0a0c0f; }

        .roster-chip { padding: 9px 14px; border-radius: 4px; font-family: 'DM Sans', sans-serif; font-size: 13px; font-weight: 500; transition: all 0.15s; border: 1.5px solid #2a2d35; background: transparent; color: #888; text-align: left; display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; }
        .roster-chip.selected { background: rgba(249,115,22,0.12); border-color: #f97316; color: #f97316; }
        .roster-chip.team-a { background: rgba(59,130,246,0.12); border-color: #3b82f6; color: #93c5fd; }
        .roster-chip.team-b { background: rgba(34,197,94,0.12); border-color: #22c55e; color: #86efac; }
        .roster-chip:hover:not(.selected):not(.team-a):not(.team-b) { border-color: #444; color: #ccc; }

        .winner-btn { font-family: 'Bebas Neue', sans-serif; font-size: 13px; letter-spacing: 2px; padding: 9px 18px; border-radius: 4px; border: 1.5px solid #2a2d35; background: transparent; color: #555; transition: all 0.15s; }
        .winner-btn.team-a { border-color: #3b82f6; color: #3b82f6; }
        .winner-btn.team-b { border-color: #22c55e; color: #22c55e; }
        .winner-btn.won-a { background: #3b82f6; border-color: #3b82f6; color: #fff; }
        .winner-btn.won-b { background: #22c55e; border-color: #22c55e; color: #000; }
        .winner-btn:hover:not(.won-a):not(.won-b) { border-color: #888; color: #ccc; }

        .wl-badge { font-family: 'DM Mono', monospace; font-size: 11px; padding: 2px 7px; border-radius: 3px; }
        .wl-w { background: rgba(34,197,94,0.15); color: #86efac; border: 1px solid rgba(34,197,94,0.3); }
        .wl-l { background: rgba(239,68,68,0.12); color: #fca5a5; border: 1px solid rgba(239,68,68,0.25); }

        .nav-btn { font-family: 'Bebas Neue', sans-serif; letter-spacing: 2px; font-size: 14px; padding: 8px 20px; border-radius: 4px; background: transparent; color: #666; border: none; transition: color 0.15s; }
        .nav-btn.active { color: #f97316; } .nav-btn:hover { color: #e8e4d9; }

        .primary-btn { background: #f97316; color: #000; font-family: 'Bebas Neue', sans-serif; letter-spacing: 2px; font-size: 16px; padding: 12px 28px; border-radius: 4px; transition: all 0.15s; border: none; }
        .primary-btn:hover { background: #fb923c; transform: translateY(-1px); } .primary-btn:active { transform: translateY(0); } .primary-btn:disabled { opacity: 0.35; pointer-events: none; }

        .ghost-btn { background: transparent; color: #666; font-family: 'DM Sans', sans-serif; font-size: 12px; padding: 6px 12px; border-radius: 4px; border: 1px solid #2a2d35; transition: all 0.15s; }
        .ghost-btn:hover { color: #e8e4d9; border-color: #555; }

        .danger-btn { background: transparent; color: #555; font-family: 'DM Mono', monospace; font-size: 11px; padding: 4px 8px; border-radius: 3px; border: 1px solid #2a2d35; transition: all 0.15s; }
        .danger-btn:hover { color: #ef4444; border-color: #ef4444; }

        .small-btn { background: transparent; color: #555; font-family: 'Bebas Neue', sans-serif; font-size: 12px; letter-spacing: 1px; padding: 5px 12px; border-radius: 3px; border: 1px solid #2a2d35; transition: all 0.15s; }
        .small-btn:hover { color: #e8e4d9; border-color: #555; }

        .section-label { font-family: 'Bebas Neue', sans-serif; font-size: 11px; letter-spacing: 3px; color: #555; margin-bottom: 8px; }
        .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: flex; align-items: center; justify-content: center; z-index: 500; padding: 20px; }
        .modal { background: #111318; border: 1px solid #2a2d35; border-radius: 10px; padding: 24px; width: 100%; max-width: 560px; max-height: 90vh; overflow-y: auto; }
        .divider { width: 1px; height: 20px; background: #2a2d35; margin: 0 4px; }

        @keyframes slideIn { from { opacity:0; transform: translateY(-8px); } to { opacity:1; transform: translateY(0); } }
        @keyframes fadeIn  { from { opacity:0; } to { opacity:1; } }
        .slide-in { animation: slideIn 0.2s ease; }
        .court-line { position: absolute; border: 1px solid rgba(249,115,22,0.04); border-radius: 50%; pointer-events: none; }
      `}</style>

      <div className="court-line" style={{ width: 600, height: 600, top: -200, right: -200 }} />
      <div className="court-line" style={{ width: 300, height: 300, top: 50, right: 50 }} />
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, transparent, #f97316, transparent)" }} />

      {notif && <div style={{ position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)", background: "#f97316", color: "#000", padding: "10px 24px", borderRadius: 4, fontFamily: "'Bebas Neue'", letterSpacing: 2, fontSize: 15, zIndex: 9999, animation: "slideIn 0.2s ease", boxShadow: "0 4px 24px rgba(249,115,22,0.4)" }}>{notif}</div>}
      {saving && <div style={{ position: "fixed", bottom: 16, right: 16, background: "#1a1d22", border: "1px solid #2a2d35", color: "#555", padding: "6px 14px", borderRadius: 4, fontFamily: "'DM Mono'", fontSize: 11, zIndex: 9999 }}>saving...</div>}

      {/* Team Setup Modal */}
      {teamSetup && activeNight && (
        <div className="modal-overlay" style={{ animation: "fadeIn 0.15s ease" }}>
          <div className="modal">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <span style={{ fontFamily: "'Bebas Neue'", fontSize: 24, letterSpacing: 3 }}>GAME {activeNight.games.length + 1} — SET TEAMS</span>
              <button className="danger-btn" onClick={() => setTeamSetup(false)}>✕</button>
            </div>
            <p style={{ fontFamily: "'DM Sans'", fontSize: 13, color: "#666", marginBottom: 20 }}>Assign players to teams so win/loss can be tracked. Or skip to track stats without W/L.</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
              {[
                { label: "TEAM A", color: "#3b82f6", cls: "team-a", state: teamA, other: teamB, set: setTeamA },
                { label: "TEAM B", color: "#22c55e", cls: "team-b", state: teamB, other: teamA, set: setTeamB },
              ].map(({ label, color, cls, state, other, set }) => (
                <div key={label}>
                  <div style={{ fontFamily: "'Bebas Neue'", fontSize: 13, letterSpacing: 3, color, marginBottom: 8 }}>{label} ({state.size})</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {sortedPlayers.filter((p) => activeNight.players.includes(p.id)).map((p) => (
                      <button key={p.id}
                        className={`roster-chip ${state.has(p.id) ? cls : other.has(p.id) ? (cls === "team-a" ? "team-b" : "team-a") : ""}`}
                        style={{ opacity: other.has(p.id) ? 0.3 : 1 }}
                        onClick={() => { if (other.has(p.id)) return; set((prev) => { const n = new Set(prev); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; }); }}>
                        <span>{p.name}</span>{state.has(p.id) && <span style={{ fontSize: 11 }}>✓</span>}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="primary-btn" onClick={startGame}>START GAME →</button>
              <button className="ghost-btn" onClick={() => { setTeamA(new Set()); setTeamB(new Set()); startGame(); }}>SKIP TEAMS</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ borderBottom: "1px solid #1a1d22", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, position: "sticky", top: 0, background: "#0a0c0f", zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>🏀</span>
          <span style={{ fontFamily: "'Bebas Neue'", fontSize: 22, letterSpacing: 3, color: "#f97316" }}>HOOPS TRACKER</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <nav style={{ display: "flex", gap: 4 }}>
            {[{ id: "roster", label: "ROSTER" }, { id: "night", label: "TRACK NIGHT" }, { id: "stats", label: "STATS" }].map(({ id, label }) => (
              <button key={id} className={`nav-btn ${view === id ? "active" : ""}`}
                onClick={() => { if (id === "night" && !activeNight) { notify("Start a night from Roster"); return; } setView(id); }}>
                {label}
              </button>
            ))}
          </nav>
          {isAdmin ? (
            <button className="danger-btn" style={{ marginLeft: 8 }} onClick={handleLogout}>SIGN OUT</button>
          ) : (
            <button className="ghost-btn" style={{ marginLeft: 8, fontSize: 11 }} onClick={() => setView("login")}>ADMIN</button>
          )}
        </div>
      </div>

      {/* Login view */}
      {view === "login" && <Login onLogin={() => setView("roster")} />}

      {view !== "login" && (
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 20px" }}>

          {loading ? (
            <div style={{ textAlign: "center", padding: 80, color: "#333", fontFamily: "'Bebas Neue'", fontSize: 18, letterSpacing: 4 }}>LOADING DATA...</div>
          ) : (
            <>

            {/* ══ ROSTER ══ */}
            {view === "roster" && (
              <div className="slide-in">
                <div style={{ marginBottom: 28 }}>
                  <h1 style={{ fontFamily: "'Bebas Neue'", fontSize: 36, letterSpacing: 4, marginBottom: 4 }}>SQUAD ROSTER</h1>
                  <p style={{ fontFamily: "'DM Sans'", fontSize: 13, color: "#555" }}>{players.length} players · Add everyone once, pick who showed up each week</p>
                </div>

                {isAdmin && (
                  <div style={{ background: "#111318", border: "1px solid #1e2128", borderRadius: 8, padding: 20, marginBottom: 20 }}>
                    <div style={{ display: "flex", gap: 10 }}>
                      <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addPlayer()} placeholder="Player name..."
                        style={{ flex: 1, background: "#0a0c0f", border: "1px solid #2a2d35", borderRadius: 4, padding: "10px 14px", color: "#e8e4d9", fontFamily: "'DM Sans'", fontSize: 14 }} />
                      <button className="primary-btn" style={{ fontSize: 14, padding: "10px 20px" }} onClick={addPlayer}>ADD PLAYER</button>
                    </div>
                  </div>
                )}

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8, marginBottom: 32 }}>
                  {players.length === 0 && <div style={{ gridColumn: "1/-1", textAlign: "center", padding: 40, color: "#333", fontFamily: "'DM Sans'", fontSize: 14, border: "1px dashed #1e2128", borderRadius: 8 }}>No players yet</div>}
                  {sortedPlayers.map((p, i) => (
                    <div key={p.id} style={{ background: "#111318", border: "1px solid #1e2128", borderRadius: 6, padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 22, height: 22, borderRadius: "50%", background: "#1e2128", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Bebas Neue'", fontSize: 11, color: "#f97316", flexShrink: 0 }}>{i + 1}</span>
                        <span style={{ fontFamily: "'DM Sans'", fontSize: 13, fontWeight: 500 }}>{p.name}</span>
                      </div>
                      {isAdmin && <button className="danger-btn" onClick={() => removePlayer(p.id)}>✕</button>}
                    </div>
                  ))}
                </div>

                {isAdmin && players.length >= 2 && (
                  <div style={{ background: "#111318", border: "1px solid #1e2128", borderRadius: 8, padding: 24 }}>
                    <h2 style={{ fontFamily: "'Bebas Neue'", fontSize: 22, letterSpacing: 3, color: "#f97316", marginBottom: 18 }}>START NIGHT SESSION</h2>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
                      <input value={nightDate} onChange={(e) => setNightDate(e.target.value)} type="date"
                        style={{ background: "#0a0c0f", border: "1px solid #2a2d35", borderRadius: 4, padding: "10px 14px", color: "#e8e4d9", fontFamily: "'DM Sans'", fontSize: 13 }} />
                      <input value={nightUrl} onChange={(e) => setNightUrl(e.target.value)} placeholder="YouTube URL (optional)..."
                        style={{ flex: 1, minWidth: 200, background: "#0a0c0f", border: "1px solid #2a2d35", borderRadius: 4, padding: "10px 14px", color: "#e8e4d9", fontFamily: "'DM Sans'", fontSize: 13 }} />
                    </div>
                    <div style={{ marginBottom: 20 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                        <span style={{ fontFamily: "'Bebas Neue'", fontSize: 14, letterSpacing: 3, color: "#888" }}>WHO PLAYED? <span style={{ color: nightPlayers.size >= 2 ? "#f97316" : "#555", marginLeft: 6 }}>{nightPlayers.size} selected</span></span>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button className="small-btn" onClick={() => setNightPlayers(new Set(players.map((p) => p.id)))}>ALL</button>
                          <button className="small-btn" onClick={() => setNightPlayers(new Set())}>NONE</button>
                        </div>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))", gap: 6 }}>
                        {sortedPlayers.map((p) => (
                          <button key={p.id} className={`roster-chip ${nightPlayers.has(p.id) ? "selected" : ""}`}
                            onClick={() => setNightPlayers((prev) => { const n = new Set(prev); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })}>
                            <span>{p.name}</span>{nightPlayers.has(p.id) && <span>✓</span>}
                          </button>
                        ))}
                      </div>
                    </div>
                    <button className="primary-btn" disabled={nightPlayers.size < 2} onClick={startNight}>BEGIN NIGHT ({nightPlayers.size}) →</button>
                  </div>
                )}

                {nights.length > 0 && (
                  <div style={{ marginTop: 32 }}>
                    <h2 style={{ fontFamily: "'Bebas Neue'", fontSize: 20, letterSpacing: 3, marginBottom: 14 }}>PAST NIGHTS</h2>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {nights.map((n) => {
                        const np = players.filter((p) => n.players.includes(p.id));
                        const nt = mergePlayerStats(n);
                        const top = np.map((p) => ({ name: p.name, p: pts(nt[p.id] || emptyStats()) })).sort((a, b) => b.p - a.p)[0];
                        const decided = n.games.filter((g) => g.winner).length;
                        return (
                          <div key={n.id} style={{ background: "#111318", border: "1px solid #1e2128", borderRadius: 6, padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                            <div>
                              <span style={{ fontFamily: "'Bebas Neue'", fontSize: 16, letterSpacing: 2 }}>{n.date}</span>
                              <span style={{ fontFamily: "'DM Mono'", fontSize: 11, color: "#555", marginLeft: 10 }}>{n.games.length} games · {np.length} players</span>
                              {decided > 0 && <span style={{ fontFamily: "'DM Mono'", fontSize: 11, color: "#555", marginLeft: 8 }}>· {decided} results</span>}
                              {top && <span style={{ fontFamily: "'DM Mono'", fontSize: 11, color: "#555", marginLeft: 8 }}>· TOP: {top.name} {top.p}pts</span>}
                            </div>
                            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                              {n.youtubeUrl && <a href={n.youtubeUrl} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "'DM Mono'", fontSize: 11, color: "#f97316", textDecoration: "none" }}>▶</a>}
                              {isAdmin && <button className="ghost-btn" onClick={() => resumeNight(n)}>EDIT</button>}
                              {isAdmin && <button className="danger-btn" onClick={() => deleteNight(n.id)}>✕</button>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ══ TRACK NIGHT ══ */}
            {view === "night" && activeNight && (
              <div className="slide-in">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
                  <div>
                    <h1 style={{ fontFamily: "'Bebas Neue'", fontSize: 32, letterSpacing: 4 }}>{activeNight.date} <span style={{ color: "#555", fontSize: 22 }}>· {activeNight.games.length} GAMES</span></h1>
                    <div style={{ display: "flex", gap: 12, marginTop: 2 }}>
                      <span style={{ fontFamily: "'DM Mono'", fontSize: 11, color: "#555" }}>{nightGamePlayers.length} players tonight</span>
                      {activeNight.youtubeUrl && <a href={activeNight.youtubeUrl} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "'DM Mono'", fontSize: 11, color: "#f97316", textDecoration: "none" }}>▶ OPEN VIDEO</a>}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="ghost-btn" onClick={openTeamSetup}>+ NEW GAME</button>
                    <button className="primary-btn" style={{ fontSize: 14, padding: "10px 20px" }} onClick={saveNight}>SAVE NIGHT ✓</button>
                  </div>
                </div>

                {activeNight.games.length > 0 && (
                  <div style={{ marginBottom: 20, background: "#111318", padding: 12, borderRadius: 8, border: "1px solid #1e2128", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ fontFamily: "'Bebas Neue'", fontSize: 11, letterSpacing: 3, color: "#555", marginRight: 4 }}>GAME:</span>
                    {activeNight.games.map((g, i) => {
                      const dotColor = g.winner === "a" ? "#3b82f6" : g.winner === "b" ? "#22c55e" : null;
                      return (
                        <button key={g.id} className={`game-tab ${activeGame === i ? "active" : ""}`} onClick={() => setActiveGame(i)}>
                          G{g.number}
                          {dotColor && <span className="win-dot" style={{ background: dotColor }} />}
                        </button>
                      );
                    })}
                    <div className="divider" />
                    {curGame && <button className="danger-btn" onClick={() => deleteGame(activeGame)}>REMOVE</button>}
                  </div>
                )}

                {activeNight.games.length === 0 && (
                  <div style={{ textAlign: "center", padding: "48px 20px", border: "1px dashed #1e2128", borderRadius: 8, marginBottom: 20 }}>
                    <div style={{ fontFamily: "'Bebas Neue'", fontSize: 20, letterSpacing: 3, color: "#333", marginBottom: 8 }}>NO GAMES YET</div>
                    <p style={{ fontFamily: "'DM Sans'", fontSize: 13, color: "#444", marginBottom: 16 }}>Hit "+ New Game" to start tracking</p>
                    <button className="primary-btn" onClick={openTeamSetup}>+ START FIRST GAME</button>
                  </div>
                )}

                {curGame && (
                  <div>
                    {/* View toggle + winner picker */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
                      {hasTeams(curGame) ? (
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <span style={{ fontFamily: "'Bebas Neue'", fontSize: 11, letterSpacing: 3, color: "#555" }}>RESULT:</span>
                          <button className={`winner-btn ${curGame.winner === "a" ? "won-a" : curGame.teams.a.length > 0 ? "team-a" : ""}`} onClick={() => setWinner(activeGame, "a")}>
                            {curGame.winner === "a" ? "🏆 TEAM A" : "TEAM A WON?"}
                          </button>
                          <span style={{ fontFamily: "'Bebas Neue'", color: "#333", fontSize: 13 }}>VS</span>
                          <button className={`winner-btn ${curGame.winner === "b" ? "won-b" : curGame.teams.b.length > 0 ? "team-b" : ""}`} onClick={() => setWinner(activeGame, "b")}>
                            {curGame.winner === "b" ? "🏆 TEAM B" : "TEAM B WON?"}
                          </button>
                        </div>
                      ) : <div />}
                      <div style={{ display: "flex", gap: 0, background: "#111318", border: "1px solid #1e2128", borderRadius: 5, overflow: "hidden" }}>
                        {[{ id: "grid", label: "⊞ ALL PLAYERS" }, { id: "focus", label: "◎ FOCUS" }].map(({ id, label }) => (
                          <button key={id} onClick={() => setTrackMode(id)}
                            style={{ fontFamily: "'Bebas Neue'", fontSize: 12, letterSpacing: 1.5, padding: "7px 14px", border: "none", cursor: "pointer", transition: "all 0.15s", background: trackMode === id ? "#f97316" : "transparent", color: trackMode === id ? "#000" : "#555" }}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Grid mode */}
                    {trackMode === "grid" && (
                      <div>
                        {curGame.teams.a.length > 0 && (
                          <div style={{ marginBottom: 20 }}>
                            <div style={{ fontFamily: "'Bebas Neue'", fontSize: 11, letterSpacing: 3, color: "#3b82f6", marginBottom: 10 }}>TEAM A {curGame.winner === "a" && "🏆"}</div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}>
                              {players.filter((p) => curGame.teams.a.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name)).map((p) => (
                                <PlayerCard key={p.id} player={p} stats={curGame.stats[p.id] || emptyStats()} team="a" onLog={(key, delta) => logStat(p.id, key, delta)} />
                              ))}
                            </div>
                          </div>
                        )}
                        {curGame.teams.b.length > 0 && (
                          <div style={{ marginBottom: 20 }}>
                            <div style={{ fontFamily: "'Bebas Neue'", fontSize: 11, letterSpacing: 3, color: "#22c55e", marginBottom: 10 }}>TEAM B {curGame.winner === "b" && "🏆"}</div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}>
                              {players.filter((p) => curGame.teams.b.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name)).map((p) => (
                                <PlayerCard key={p.id} player={p} stats={curGame.stats[p.id] || emptyStats()} team="b" onLog={(key, delta) => logStat(p.id, key, delta)} />
                              ))}
                            </div>
                          </div>
                        )}
                        {curGame.teams.a.length === 0 && curGame.teams.b.length === 0 && (
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10, marginBottom: 20 }}>
                            {curGamePlayers.map((p) => (
                              <PlayerCard key={p.id} player={p} stats={curGame.stats[p.id] || emptyStats()} team={null} onLog={(key, delta) => logStat(p.id, key, delta)} />
                            ))}
                          </div>
                        )}
                        <div style={{ marginTop: 8 }}>
                          <div className="section-label">GAME {curGame.number} BOX SCORE</div>
                          <BoxScore players={curGamePlayers} stats={curGame.stats} activePid={null} game={curGame} />
                        </div>
                      </div>
                    )}

                    {/* Focus mode */}
                    {trackMode === "focus" && (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                        <div>
                          <div style={{ marginBottom: 14 }}>
                            <div className="section-label">SELECT PLAYER</div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                              {curGamePlayers.map((p) => {
                                const team = playerTeam(curGame, p.id);
                                const won  = playerWon(curGame, p.id);
                                return (
                                  <button key={p.id} className={`player-chip ${activePid === p.id ? "active" : ""}`} onClick={() => setActivePid(p.id)}
                                    style={{ borderColor: activePid !== p.id && team === "a" ? "#3b82f630" : activePid !== p.id && team === "b" ? "#22c55e30" : undefined }}>
                                    {won === true && <span style={{ fontSize: 9, marginRight: 3 }}>✓</span>}
                                    {won === false && <span style={{ fontSize: 9, marginRight: 3, opacity: 0.5 }}>✗</span>}
                                    {p.name} <span style={{ fontSize: 10, opacity: 0.7, marginLeft: 3 }}>{pts(curGame.stats[p.id] || emptyStats())}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                          {activePid && (
                            <div style={{ background: "#111318", border: "1px solid #1e2128", borderRadius: 8, padding: 16 }}>
                              <div style={{ marginBottom: 14, paddingBottom: 12, borderBottom: "1px solid #1e2128" }}>
                                <span style={{ fontFamily: "'Bebas Neue'", fontSize: 22, letterSpacing: 2, color: "#f97316" }}>{players.find((p) => p.id === activePid)?.name}</span>
                                <span style={{ fontFamily: "'DM Mono'", fontSize: 12, color: "#666", marginLeft: 10 }}>{pts(curStats)} PTS · {curStats.reb} REB · {curStats.ast} AST · {fgpct(curStats)}</span>
                              </div>
                              <div className="section-label">SCORING</div>
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 7, marginBottom: 14 }}>
                                {[{ key: "pts2", label: "2-POINTER", sub: "+2 pts" }, { key: "pts3", label: "3-POINTER", sub: "+3 pts" }].map(({ key, label, sub }) => (
                                  <button key={key} className="stat-btn" onClick={() => logStat(activePid, key)}>
                                    <div className="val">{curStats[key]}</div>
                                    <div style={{ fontFamily: "'DM Mono'", fontSize: 10 }}>{label}</div>
                                    <div style={{ fontSize: 9, color: "#f97316", fontFamily: "'DM Mono'" }}>{sub}</div>
                                  </button>
                                ))}
                              </div>
                              <div className="section-label">SHOOTING · FG% {fgpct(curStats)} · auto-tracked</div>
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 7, marginBottom: 14 }}>
                                {[{ key: "fgm", label: "FG MADE" }, { key: "fga", label: "FG ATTEMPTED" }].map(({ key, label }) => (
                                  <button key={key} className="stat-btn" onClick={() => logStat(activePid, key)}>
                                    <div className="val">{curStats[key]}</div>
                                    <div style={{ fontFamily: "'DM Mono'", fontSize: 10 }}>{label}</div>
                                  </button>
                                ))}
                              </div>
                              <div className="section-label">OTHER</div>
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 7, marginBottom: 14 }}>
                                {[{ key: "reb", label: "REB" }, { key: "ast", label: "AST" }, { key: "stl", label: "STL" }, { key: "to", label: "TO" }].map(({ key, label }) => (
                                  <button key={key} className="stat-btn" onClick={() => logStat(activePid, key)}>
                                    <div className="val">{curStats[key]}</div>
                                    <div style={{ fontFamily: "'DM Mono'", fontSize: 10 }}>{label}</div>
                                  </button>
                                ))}
                              </div>
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                                <span style={{ fontFamily: "'Bebas Neue'", fontSize: 11, color: "#555", letterSpacing: 2 }}>UNDO:</span>
                                {STAT_BTNS.map(({ key, label }) => (
                                  <button key={key} className="ghost-btn" style={{ fontSize: 11, padding: "3px 7px" }} onClick={() => logStat(activePid, key, -1)}>-{label}</button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                          <div>
                            <div className="section-label">GAME {curGame.number} BOX SCORE</div>
                            <BoxScore players={curGamePlayers} stats={curGame.stats} activePid={activePid} onSelect={setActivePid} game={curGame} />
                          </div>
                          <div>
                            <div className="section-label">NIGHT TOTALS ({activeNight.games.length} GAMES)</div>
                            <BoxScore players={nightGamePlayers} stats={nightTotals} activePid={activePid} onSelect={setActivePid} dim />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {view === "night" && !activeNight && (
              <div style={{ textAlign: "center", padding: 80, color: "#333", fontFamily: "'DM Sans'", fontSize: 14 }}>
                No active session. <button className="ghost-btn" style={{ display: "inline" }} onClick={() => setView("roster")}>Go to Roster</button> to start one.
              </div>
            )}

            {/* ══ STATS ══ */}
            {view === "stats" && (
              <div className="slide-in">
                <div style={{ marginBottom: 28 }}>
                  <h1 style={{ fontFamily: "'Bebas Neue'", fontSize: 36, letterSpacing: 4, marginBottom: 4 }}>SEASON STATS</h1>
                  <p style={{ fontFamily: "'DM Sans'", fontSize: 13, color: "#555" }}>
                    {nights.length} night{nights.length !== 1 ? "s" : ""} · {nights.reduce((a, n) => a + n.games.length, 0)} total games
                  </p>
                </div>

                {nights.length === 0 ? (
                  <div style={{ textAlign: "center", padding: 80, color: "#333", border: "1px dashed #1e2128", borderRadius: 8, fontFamily: "'DM Sans'", fontSize: 14 }}>No nights recorded yet</div>
                ) : (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 28 }}>
                      {[
                        { label: "POINTS LEADER",  val: (d) => pts(d.totals), fmt: (d) => pts(d.totals) + " PTS", accent: "#f97316" },
                        { label: "REBOUND LEADER", val: (d) => d.totals.reb,  fmt: (d) => d.totals.reb + " REB",  accent: "#f97316" },
                        { label: "ASSIST LEADER",  val: (d) => d.totals.ast,  fmt: (d) => d.totals.ast + " AST",  accent: "#f97316" },
                        { label: "WIN% LEADER",    val: (d) => (d.w + d.l) >= 3 ? d.w / (d.w + d.l) : -1, fmt: (d) => `${d.w}W-${d.l}L`, accent: "#22c55e" },
                      ].map(({ label, val, fmt, accent }) => {
                        const leader = players.filter((p) => (seasonData[p.id]?.nights || 0) > 0)
                          .sort((a, b) => val(seasonData[b.id] || { totals: emptyStats(), w: 0, l: 0, gp: 0 }) - val(seasonData[a.id] || { totals: emptyStats(), w: 0, l: 0, gp: 0 }))[0];
                        if (!leader) return null;
                        const d = seasonData[leader.id];
                        return (
                          <div key={label} style={{ background: "#111318", borderLeft: `3px solid ${accent}`, border: "1px solid #1e2128", borderRadius: 8, padding: "14px 16px" }}>
                            <div style={{ fontFamily: "'Bebas Neue'", fontSize: 11, letterSpacing: 3, color: accent, marginBottom: 4 }}>{label}</div>
                            <div style={{ fontFamily: "'Bebas Neue'", fontSize: 20, letterSpacing: 2 }}>{leader.name}</div>
                            <div style={{ fontFamily: "'DM Mono'", fontSize: 16, color: "#888" }}>{fmt(d)}</div>
                            {label === "WIN% LEADER" && <div style={{ fontFamily: "'DM Mono'", fontSize: 11, color: "#555", marginTop: 2 }}>{winpct(d.w, d.l)} win rate</div>}
                          </div>
                        );
                      })}
                    </div>

                    <div style={{ background: "#111318", border: "1px solid #1e2128", borderRadius: 8, overflow: "auto", marginBottom: 32 }}>
                      <SeasonTable players={sortedSeason} seasonData={seasonData} />
                    </div>

                    <h2 style={{ fontFamily: "'Bebas Neue'", fontSize: 20, letterSpacing: 3, marginBottom: 14 }}>NIGHT LOG</h2>
                    {nights.map((n) => {
                      const np = players.filter((p) => n.players.includes(p.id));
                      const nt = mergePlayerStats(n);
                      return (
                        <div key={n.id} style={{ background: "#111318", border: "1px solid #1e2128", borderRadius: 8, marginBottom: 16, overflow: "hidden" }}>
                          <div style={{ padding: "12px 16px", borderBottom: "1px solid #1e2128", background: "#0f1115", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <div>
                              <span style={{ fontFamily: "'Bebas Neue'", fontSize: 18, letterSpacing: 3 }}>{n.date}</span>
                              <span style={{ fontFamily: "'DM Mono'", fontSize: 11, color: "#555", marginLeft: 10 }}>{n.games.length} games · {np.length} players</span>
                            </div>
                            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                              {n.youtubeUrl && <a href={n.youtubeUrl} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "'DM Mono'", fontSize: 11, color: "#f97316", textDecoration: "none" }}>▶ WATCH</a>}
                              {isAdmin && <button className="ghost-btn" onClick={() => resumeNight(n)}>+ ADD GAMES</button>}
                            </div>
                          </div>
                          <div style={{ padding: "12px 16px", borderBottom: "1px solid #1e2128" }}>
                            <div className="section-label" style={{ marginBottom: 10 }}>NIGHT TOTALS</div>
                            <BoxScore players={np} stats={nt} compact />
                          </div>
                          <div style={{ padding: "12px 16px" }}>
                            <div className="section-label" style={{ marginBottom: 10 }}>PER GAME</div>
                            <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4 }}>
                              {n.games.map((g, gi) => {
                                const gp = players.filter((p) => g.teams.a.includes(p.id) || g.teams.b.includes(p.id) || (g.teams.a.length === 0 && n.players.includes(p.id)));
                                const ht = hasTeams(g);
                                return (
                                  <div key={g.id} style={{ minWidth: 170, background: "#0f1115", border: `1px solid ${g.winner ? (g.winner === "a" ? "#3b82f620" : "#22c55e20") : "#1e2128"}`, borderRadius: 6, padding: "10px 12px", flexShrink: 0 }}>
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                                      <span style={{ fontFamily: "'Bebas Neue'", fontSize: 13, letterSpacing: 2, color: "#f97316" }}>GAME {g.number}</span>
                                      {g.winner && <span style={{ fontFamily: "'DM Mono'", fontSize: 10, color: g.winner === "a" ? "#93c5fd" : "#86efac" }}>TEAM {g.winner.toUpperCase()} WIN</span>}
                                    </div>
                                    {ht && isAdmin && (
                                      <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                                        {["a", "b"].map((team) => (
                                          <button key={team} onClick={() => setWinnerSaved(n.id, gi, team)}
                                            style={{ flex: 1, fontFamily: "'Bebas Neue'", fontSize: 10, letterSpacing: 1, padding: "4px 0", borderRadius: 3, border: "1px solid", borderColor: g.winner === team ? (team === "a" ? "#3b82f6" : "#22c55e") : "#2a2d35", background: g.winner === team ? (team === "a" ? "#3b82f6" : "#22c55e") : "transparent", color: g.winner === team ? (team === "a" ? "#fff" : "#000") : "#555", cursor: "pointer" }}>
                                            {team.toUpperCase()} {g.winner === team ? "✓" : ""}
                                          </button>
                                        ))}
                                      </div>
                                    )}
                                    {gp.map((p) => {
                                      const s = g.stats[p.id] || emptyStats();
                                      const won = playerWon(g, p.id);
                                      return (
                                        <div key={p.id} style={{ marginBottom: 5, display: "flex", alignItems: "flex-start", gap: 5 }}>
                                          {won !== null && <span style={{ fontSize: 9, marginTop: 2, color: won ? "#86efac" : "#fca5a5", flexShrink: 0 }}>{won ? "W" : "L"}</span>}
                                          <div>
                                            <div style={{ fontFamily: "'DM Sans'", fontSize: 11, fontWeight: 600, color: "#ccc" }}>{p.name}</div>
                                            <div style={{ fontFamily: "'DM Mono'", fontSize: 10, color: "#666" }}>
                                              <span style={{ color: "#e8e4d9" }}>{pts(s)}</span>pts · {s.fgm}/{s.fga} · {s.reb}r · {s.ast}a
                                            </div>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── PlayerCard ───────────────────────────────────────────────────────────────

function PlayerCard({ player, stats, team, onLog }) {
  const s = stats;
  const p_ = pts(s);
  const teamColor = team === "a" ? "#3b82f6" : team === "b" ? "#22c55e" : "#f97316";
  return (
    <div style={{ background: "#111318", border: `1px solid ${teamColor}22`, borderTop: `2px solid ${teamColor}`, borderRadius: 8, padding: "10px 10px 8px", display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ paddingBottom: 6, borderBottom: "1px solid #1e2128" }}>
        <div style={{ fontFamily: "'Bebas Neue'", fontSize: 15, letterSpacing: 1.5, color: "#e8e4d9", lineHeight: 1, marginBottom: 2 }}>{player.name}</div>
        <div style={{ fontFamily: "'DM Mono'", fontSize: 10, color: "#555" }}>
          <span style={{ color: p_ > 0 ? "#e8e4d9" : "#555", fontWeight: 600 }}>{p_}pts</span>
          {" · "}{s.fgm}/{s.fga} FG {s.fga > 0 ? `(${fgpct(s)})` : ""}
          {" · "}{s.reb}r {s.ast}a
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
        {[
          { key: "pts2", label: "2PT", sub: `×${s.pts2}` },
          { key: "pts3", label: "3PT", sub: `×${s.pts3}` },
          { key: "reb",  label: "REB", sub: `×${s.reb}`  },
          { key: "ast",  label: "AST", sub: `×${s.ast}`  },
          { key: "stl",  label: "STL", sub: `×${s.stl}`  },
          { key: "to",   label: "TO",  sub: `×${s.to}`   },
        ].map(({ key, label, sub }) => (
          <button key={key} onClick={() => onLog(key, 1)}
            style={{ background: "#1a1d22", border: "1px solid #2a2d35", borderRadius: 5, padding: "6px 2px", cursor: "pointer", transition: "all 0.12s", display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}
            onMouseEnter={(e) => { e.currentTarget.style.background = teamColor; e.currentTarget.style.borderColor = teamColor; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "#1a1d22"; e.currentTarget.style.borderColor = "#2a2d35"; }}>
            <span style={{ fontFamily: "'Bebas Neue'", fontSize: 13, letterSpacing: 1, lineHeight: 1, color: "#e8e4d9" }}>{label}</span>
            <span style={{ fontFamily: "'DM Mono'", fontSize: 10, color: "#888", lineHeight: 1 }}>{sub}</span>
          </button>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
        <button onClick={() => onLog("fga", 1)}
          style={{ background: "#1a1d22", border: "1px solid #2a2d35", borderRadius: 5, padding: "5px 4px", cursor: "pointer", transition: "all 0.12s", display: "flex", flexDirection: "column", alignItems: "center" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "#ef444420"; e.currentTarget.style.borderColor = "#ef4444"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "#1a1d22"; e.currentTarget.style.borderColor = "#2a2d35"; }}>
          <span style={{ fontFamily: "'Bebas Neue'", fontSize: 11, letterSpacing: 1, color: "#888" }}>MISS</span>
          <span style={{ fontFamily: "'DM Mono'", fontSize: 9, color: "#555" }}>+FGA</span>
        </button>
        <button onClick={() => onLog("fgm", 1)}
          style={{ background: "#1a1d22", border: "1px solid #2a2d35", borderRadius: 5, padding: "5px 4px", cursor: "pointer", transition: "all 0.12s", display: "flex", flexDirection: "column", alignItems: "center" }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#555"; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#2a2d35"; }}>
          <span style={{ fontFamily: "'Bebas Neue'", fontSize: 11, letterSpacing: 1, color: "#888" }}>+FGM</span>
          <span style={{ fontFamily: "'DM Mono'", fontSize: 9, color: "#555" }}>manual</span>
        </button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3, paddingTop: 4, borderTop: "1px solid #1e2128" }}>
        <span style={{ fontFamily: "'Bebas Neue'", fontSize: 9, letterSpacing: 2, color: "#444", display: "flex", alignItems: "center", marginRight: 2 }}>UNDO</span>
        {[
          { key: "pts2", label: "2" }, { key: "pts3", label: "3" },
          { key: "reb", label: "R" }, { key: "ast", label: "A" },
          { key: "stl", label: "S" }, { key: "to",  label: "T" },
          { key: "fga", label: "FGA" }, { key: "fgm", label: "FGM" },
        ].map(({ key, label }) => (
          <button key={key} onClick={() => onLog(key, -1)}
            style={{ fontFamily: "'DM Mono'", fontSize: 9, padding: "2px 5px", borderRadius: 3, border: "1px solid #2a2d35", background: "transparent", color: "#444", cursor: "pointer", transition: "all 0.1s" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "#fca5a5"; e.currentTarget.style.borderColor = "#ef4444"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "#444"; e.currentTarget.style.borderColor = "#2a2d35"; }}>
            -{label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── BoxScore ─────────────────────────────────────────────────────────────────

function BoxScore({ players, stats, activePid, onSelect, game, dim, compact }) {
  const cols = compact ? "1fr 40px 44px 44px 40px 40px" : "1fr 44px 44px 44px 40px 40px 40px 40px";
  const sortedPlayers = game && (game.teams.a.length > 0 || game.teams.b.length > 0)
    ? [
        ...players.filter((p) => game.teams.a.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name)),
        ...players.filter((p) => game.teams.b.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name)),
        ...players.filter((p) => !game.teams.a.includes(p.id) && !game.teams.b.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name)),
      ]
    : players;
  const teamAIds = game?.teams.a || [];
  const teamBIds = game?.teams.b || [];
  return (
    <div style={{ background: "#0f1115", border: "1px solid #1e2128", borderRadius: 6, overflow: "hidden" }}>
      <div style={{ padding: "7px 12px", borderBottom: "1px solid #1e2128", fontFamily: "'Bebas Neue'", fontSize: 10, letterSpacing: 3, color: "#444", display: "grid", gridTemplateColumns: cols, textAlign: "right", minWidth: compact ? 300 : 380 }}>
        <span style={{ textAlign: "left" }}>PLAYER</span>
        <span>PTS</span><span>FG%</span><span>REB</span><span>AST</span>
        {!compact && <><span>STL</span><span>TO</span><span>FGM/A</span></>}
      </div>
      {sortedPlayers.map((p, i) => {
        const prevP = sortedPlayers[i - 1];
        const showDivider = game && i > 0 && teamAIds.includes(prevP?.id) && teamBIds.includes(p.id);
        const s = stats[p.id] || emptyStats();
        const p_ = pts(s);
        const isActive = activePid === p.id;
        const team = game ? playerTeam(game, p.id) : null;
        const won  = game ? playerWon(game, p.id)  : null;
        return (
          <React.Fragment key={p.id}>
            {showDivider && <div style={{ height: 1, background: "#2a2d35", margin: "0 12px" }} />}
            <div onClick={() => onSelect && onSelect(p.id)}
              style={{ padding: "8px 12px", borderBottom: "1px solid #0a0c0f", display: "grid", gridTemplateColumns: cols, textAlign: "right", fontFamily: "'DM Mono'", fontSize: 12, cursor: onSelect ? "pointer" : "default", background: isActive ? "rgba(249,115,22,0.06)" : "transparent", transition: "background 0.1s", minWidth: compact ? 300 : 380 }}>
              <span style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 5 }}>
                {team === "a" && <span style={{ width: 3, height: 12, borderRadius: 2, background: "#3b82f6", flexShrink: 0 }} />}
                {team === "b" && <span style={{ width: 3, height: 12, borderRadius: 2, background: "#22c55e", flexShrink: 0 }} />}
                {won !== null && <span style={{ fontSize: 9, color: won ? "#86efac" : "#fca5a5" }}>{won ? "W" : "L"}</span>}
                <span style={{ fontFamily: "'DM Sans'", fontSize: 12, fontWeight: 500, color: isActive ? "#f97316" : dim ? "#555" : "#e8e4d9" }}>{p.name}</span>
              </span>
              <span style={{ color: p_ > 0 ? "#e8e4d9" : "#333" }}>{p_ || "—"}</span>
              <span style={{ color: "#666" }}>{fgpct(s)}</span>
              <span style={{ color: s.reb > 0 ? "#888" : "#333" }}>{s.reb || "—"}</span>
              <span style={{ color: s.ast > 0 ? "#888" : "#333" }}>{s.ast || "—"}</span>
              {!compact && <>
                <span style={{ color: s.stl > 0 ? "#888" : "#333" }}>{s.stl || "—"}</span>
                <span style={{ color: s.to  > 0 ? "#888" : "#333" }}>{s.to  || "—"}</span>
                <span style={{ color: "#555", fontSize: 11 }}>{s.fgm}/{s.fga}</span>
              </>}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─── SeasonTable ──────────────────────────────────────────────────────────────

function SeasonTable({ players, seasonData }) {
  const cols = "1fr 40px 44px 50px 44px 44px 44px 44px 44px 44px 52px 52px";
  const [sortKey, setSortKey] = useState("pts");
  const [sortAsc, setSortAsc] = useState(false);
  const handleSort = (key) => {
    if (sortKey === key) setSortAsc((a) => !a);
    else { setSortKey(key); setSortAsc(false); }
  };
  const COLS = [
    { key: "player", label: "PLAYER", align: "left",  getValue: (d, p) => p.name },
    { key: "ngt",    label: "NGT",    align: "right", getValue: (d)    => d.nights },
    { key: "gp",     label: "GP",     align: "right", getValue: (d)    => d.gp },
    { key: "pts",    label: "PTS",    align: "right", getValue: (d)    => pts(d.totals) },
    { key: "fgpct",  label: "FG%",    align: "right", getValue: (d)    => d.totals.fga > 0 ? d.totals.fgm / d.totals.fga : -1 },
    { key: "reb",    label: "REB",    align: "right", getValue: (d)    => d.totals.reb },
    { key: "ast",    label: "AST",    align: "right", getValue: (d)    => d.totals.ast },
    { key: "stl",    label: "STL",    align: "right", getValue: (d)    => d.totals.stl },
    { key: "to",     label: "TO",     align: "right", getValue: (d)    => d.totals.to },
    { key: "fgm",    label: "FGM",    align: "right", getValue: (d)    => d.totals.fgm },
    { key: "wl",     label: "W-L",    align: "right", getValue: (d)    => d.w - d.l },
    { key: "winpct", label: "WIN%",   align: "right", getValue: (d)    => (d.w + d.l) > 0 ? d.w / (d.w + d.l) : -1 },
  ];
  const activeSortCol = COLS.find((c) => c.key === sortKey);
  const sortedPlayers = [...players].sort((a, b) => {
    const da = seasonData[a.id] || { totals: emptyStats(), gp: 0, nights: 0, w: 0, l: 0 };
    const db = seasonData[b.id] || { totals: emptyStats(), gp: 0, nights: 0, w: 0, l: 0 };
    if (da.nights === 0 && db.nights !== 0) return 1;
    if (da.nights !== 0 && db.nights === 0) return -1;
    const va = activeSortCol.getValue(da, a);
    const vb = activeSortCol.getValue(db, b);
    const cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
    return sortAsc ? cmp : -cmp;
  });
  return (
    <>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid #1e2128", fontFamily: "'Bebas Neue'", fontSize: 11, letterSpacing: 3, display: "grid", gridTemplateColumns: cols, textAlign: "right", minWidth: 720 }}>
        {COLS.map((c) => {
          const isActive = sortKey === c.key;
          const isGreen  = c.key === "wl" || c.key === "winpct";
          const arrow    = isActive ? (sortAsc ? " ▲" : " ▼") : "";
          return (
            <span
              key={c.key}
              onClick={() => handleSort(c.key)}
              style={{
                textAlign: c.align,
                cursor: "pointer",
                color: isActive ? "#f97316" : isGreen ? "#22c55e" : "#555",
                userSelect: "none",
              }}
            >
              {c.label}{arrow}
            </span>
          );
        })}
      </div>
      {sortedPlayers.map((p, i) => {
        const d = seasonData[p.id] || { totals: emptyStats(), gp: 0, nights: 0, w: 0, l: 0 };
        const p_ = pts(d.totals);
        const dim = d.nights === 0;
        const hasWL = (d.w + d.l) > 0;
        return (
          <div key={p.id} style={{ padding: "11px 16px", borderBottom: "1px solid #0f1115", background: i === 0 && !dim ? "rgba(249,115,22,0.04)" : "transparent", display: "grid", gridTemplateColumns: cols, textAlign: "right", fontFamily: "'DM Mono'", fontSize: 13, minWidth: 720 }}>
            <span style={{ textAlign: "left", fontFamily: "'DM Sans'", fontWeight: 500, color: dim ? "#2a2d35" : i === 0 ? "#f97316" : "#e8e4d9", display: "flex", alignItems: "center", gap: 6 }}>
              {i === 0 && !dim && <span>👑</span>}{p.name}
            </span>
            <span style={{ color: dim ? "#2a2d35" : "#888" }}>{dim ? "—" : d.nights}</span>
            <span style={{ color: dim ? "#2a2d35" : "#888" }}>{dim ? "—" : d.gp}</span>
            <span style={{ color: dim ? "#2a2d35" : p_ > 0 ? "#e8e4d9" : "#555", fontWeight: 600 }}>{dim || p_ === 0 ? "—" : p_}</span>
            <span style={{ color: dim ? "#2a2d35" : "#888" }}>{dim ? "—" : fgpct(d.totals)}</span>
            <span style={{ color: dim ? "#2a2d35" : "#888" }}>{dim || !d.totals.reb ? "—" : d.totals.reb}</span>
            <span style={{ color: dim ? "#2a2d35" : "#888" }}>{dim || !d.totals.ast ? "—" : d.totals.ast}</span>
            <span style={{ color: dim ? "#2a2d35" : "#888" }}>{dim || !d.totals.stl ? "—" : d.totals.stl}</span>
            <span style={{ color: dim ? "#2a2d35" : "#888" }}>{dim || !d.totals.to  ? "—" : d.totals.to}</span>
            <span style={{ color: dim ? "#2a2d35" : "#555", fontSize: 11 }}>{dim || !d.totals.fgm ? "—" : `${d.totals.fgm}/${d.totals.fga}`}</span>
            <span style={{ color: !hasWL ? "#2a2d35" : "#e8e4d9" }}>
              {!hasWL ? "—" : <><span style={{ color: "#86efac" }}>{d.w}W</span><span style={{ color: "#555" }}>-</span><span style={{ color: "#fca5a5" }}>{d.l}L</span></>}
            </span>
            <span style={{ color: !hasWL ? "#2a2d35" : d.w / (d.w + d.l) >= 0.6 ? "#86efac" : d.w / (d.w + d.l) <= 0.4 ? "#fca5a5" : "#888" }}>
              {!hasWL ? "—" : winpct(d.w, d.l)}
            </span>
          </div>
        );
      })}
    </>
  );
}
