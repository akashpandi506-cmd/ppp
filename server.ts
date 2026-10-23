/**
 * ChessVerse 3D - Full-Stack Express & Real-Time WebSocket Server
 */
import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import {
  generatePublicUID,
  evaluateTTT,
  isLegalTTTMove,
  getChessState,
  TTTBoard,
} from './src/game/rules.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const DATA_DIR = path.join(__dirname, '.data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ----------------------------------------------------
// DATABASE STRUCTURE & SEEDING
// ----------------------------------------------------
interface UserRecord {
  id: string;
  username: string;
  username_normalized: string;
  public_uid: string;
  password_hash: string;
  salt: string;
  avatar_url: string;
  status_text?: string;
  created_at: string;
  stats: {
    chess: { wins: number; losses: number; draws: number; rating: number };
    ttt: { wins: number; losses: number; draws: number };
  };
  privacy_settings: {
    show_online: boolean;
    allow_invites: boolean;
  };
}

interface FriendshipRecord {
  id: string;
  requester_id: string;
  receiver_id: string;
  status: 'pending' | 'accepted' | 'declined' | 'blocked';
  created_at: string;
}

interface MessageRecord {
  id: string;
  conversation_id: string;
  sender_id: string;
  receiver_id: string;
  content: string;
  created_at: string;
  read: boolean;
}

interface GameInvitationRecord {
  id: string;
  inviter_id: string;
  invitee_id: string;
  game_type: 'chess' | 'ttt';
  status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired';
  room_id: string;
  created_at: string;
}

interface MatchHistoryRecord {
  id: string;
  user_id: string;
  opponent_name: string;
  opponent_avatar: string;
  game_type: 'chess' | 'ttt';
  result: 'Won' | 'Lost' | 'Draw';
  time_ago: string;
  created_at: string;
}

interface GameRoomRecord {
  id: string;
  room_code: string;
  game_type: 'chess' | 'ttt';
  mode: 'online' | 'ai';
  max_players?: 2 | 3;
  participants?: string[];
  player_one_id: string;
  player_two_id: string | null;
  player_three_id?: string | null;
  player_one_symbol: string; // 'w' for chess, 'X' for TTT
  player_two_symbol: string; // 'b' for chess, 'O' for TTT
  player_three_symbol?: string; // 'S' / 'Δ' for 3rd participant
  current_turn: string; // 'w'|'b' or 'X'|'O'
  game_state: any;
  state_version: number;
  winner_id: string | null; // user id or 'draw' or null
  status: 'waiting' | 'active' | 'finished';
  move_history: any[];
  chat_messages: {
    id: string;
    room_id?: string;
    sender_id: string;
    sender_uid?: string;
    sender_name: string;
    content: string;
    created_at: string;
  }[];
  created_at: string;
  updated_at: string;
}

interface DatabaseSchema {
  users: Record<string, UserRecord>;
  friendships: FriendshipRecord[];
  messages: MessageRecord[];
  invitations: GameInvitationRecord[];
  game_rooms: Record<string, GameRoomRecord>;
  match_history: MatchHistoryRecord[];
}

let db: DatabaseSchema = {
  users: {},
  friendships: [],
  messages: [],
  invitations: [],
  game_rooms: {},
  match_history: [],
};

function saveDb() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save DB:', err);
  }
}

function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
}

const DEFAULT_BOTS = [
  {
    id: 'bot-saraqueen',
    username: 'SaraQueen',
    public_uid: 'CV-4F8Z1Q9L',
    avatar_url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
    status_text: 'Playing Chess • 2m',
    stats: { chess: { wins: 318, losses: 42, draws: 29, rating: 2420 }, ttt: { wins: 88, losses: 14, draws: 9 } },
  },
  {
    id: 'bot-gamingpro',
    username: 'GamingPro',
    public_uid: 'CV-9X2M4K8P',
    avatar_url: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80',
    status_text: 'Online',
    stats: { chess: { wins: 215, losses: 58, draws: 19, rating: 2110 }, ttt: { wins: 112, losses: 22, draws: 11 } },
  },
  {
    id: 'bot-alexr',
    username: 'AlexR',
    public_uid: 'CV-3N7V5B2Q',
    avatar_url: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80',
    status_text: 'In Game • 6m',
    stats: { chess: { wins: 164, losses: 71, draws: 25, rating: 1890 }, ttt: { wins: 64, losses: 29, draws: 8 } },
  },
  {
    id: 'bot-priya',
    username: 'Priya',
    public_uid: 'CV-6H8J2W4Y',
    avatar_url: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=150&auto=format&fit=crop&q=80',
    status_text: 'Online',
    stats: { chess: { wins: 245, losses: 39, draws: 30, rating: 2280 }, ttt: { wins: 134, losses: 18, draws: 12 } },
  },
  {
    id: 'bot-teamchess',
    username: 'TeamChess',
    public_uid: 'CV-5T9R3C7L',
    avatar_url: 'https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=150&auto=format&fit=crop&q=80',
    status_text: 'In Lobby • 12m',
    stats: { chess: { wins: 190, losses: 52, draws: 18, rating: 2040 }, ttt: { wins: 77, losses: 20, draws: 6 } },
  },
  {
    id: 'bot-magnus',
    username: 'Grandmaster_Magnus',
    public_uid: 'CV-GM88X99A',
    avatar_url: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=150&auto=format&fit=crop&q=80',
    status_text: 'Online',
    stats: { chess: { wins: 412, losses: 18, draws: 45, rating: 2850 }, ttt: { wins: 50, losses: 0, draws: 2 } },
  },
  {
    id: 'bot-neon',
    username: 'NeonKnight',
    public_uid: 'CV-NK44A29B',
    avatar_url: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80',
    status_text: 'Online',
    stats: { chess: { wins: 180, losses: 65, draws: 24, rating: 1940 }, ttt: { wins: 95, losses: 30, draws: 15 } },
  },
];

function ensureUserSeededData(userId: string) {
  if (!db.match_history) db.match_history = [];

  // Ensure new or existing human accounts have default friendships and starter messages with our community bots
  const friendBots = ['bot-saraqueen', 'bot-gamingpro', 'bot-alexr', 'bot-priya', 'bot-teamchess'];
  for (const botId of friendBots) {
    if (db.users[botId] && botId !== userId) {
      const exists = db.friendships.some(
        (f) =>
          (f.requester_id === userId && f.receiver_id === botId) ||
          (f.requester_id === botId && f.receiver_id === userId)
      );
      if (!exists) {
        db.friendships.push({
          id: `fr-seed-${userId}-${botId}`,
          requester_id: botId,
          receiver_id: userId,
          status: 'accepted',
          created_at: new Date().toISOString(),
        });
      }
    }
  }

  // Ensure starter messages for our main community bots
  const saraConvId = [userId, 'bot-saraqueen'].sort().join('_');
  const existingSaraMsgs = db.messages.filter((m) => m.conversation_id === saraConvId);
  if (db.users['bot-saraqueen'] && userId !== 'bot-saraqueen' && existingSaraMsgs.length <= 1) {
    // Replace single starter message with a realistic scrollable conversation history
    db.messages = db.messages.filter((m) => m.conversation_id !== saraConvId);
    const saraHistory = [
      { fromBot: true, text: 'Welcome to ChessVerse 3D! Loved our opening sequence in the Sicilian Defense earlier.', minsAgo: 45 },
      { fromBot: false, text: 'Thanks Sara! That knight sacrifice on f5 really caught me off guard.', minsAgo: 42 },
      { fromBot: true, text: 'It is one of my favorite tactical motifs when the center stays closed.', minsAgo: 39 },
      { fromBot: false, text: 'I noticed how quickly your rooks doubled on the d-file right after castling.', minsAgo: 35 },
      { fromBot: true, text: 'Control of the open file is everything in the middlegame!', minsAgo: 31 },
      { fromBot: false, text: 'Have you tried the new Cyber Luxury 3D board theme yet?', minsAgo: 27 },
      { fromBot: true, text: 'Yes! The sculpted pieces and marble reflections look incredible in full screen.', minsAgo: 24 },
      { fromBot: false, text: 'Agreed, switching between 3D and 2D Staunton view mid-game is super smooth.', minsAgo: 20 },
      { fromBot: true, text: 'We should also host a 3-player room later tonight with GamingPro.', minsAgo: 16 },
      { fromBot: false, text: 'Count me in! Let me warm up with a quick 10-minute rapid game first.', minsAgo: 12 },
      { fromBot: true, text: 'Awesome, watch out for the queenside pawn storm this time!', minsAgo: 9 },
      { fromBot: false, text: 'My bishop pair is ready for it.', minsAgo: 6 },
      { fromBot: true, text: 'Hey! Ready for a 3D Chess match?', minsAgo: 2 },
    ];
    saraHistory.forEach((item, idx) => {
      db.messages.push({
        id: `msg-seed-${userId}-bot-saraqueen-${idx}`,
        conversation_id: saraConvId,
        sender_id: item.fromBot ? 'bot-saraqueen' : userId,
        receiver_id: item.fromBot ? userId : 'bot-saraqueen',
        content: item.text,
        created_at: new Date(Date.now() - item.minsAgo * 60000).toISOString(),
        read: idx < saraHistory.length - 1,
      });
    });
  }

  const starterChats = [
    { botId: 'bot-gamingpro', text: 'Great game earlier! Let us rematch soon.', minsAgo: 8 },
    { botId: 'bot-priya', text: 'Nice move on the queenside attack!', minsAgo: 12 },
    { botId: 'bot-teamchess', text: 'Invite to play chess whenever you are free!', minsAgo: 15 },
  ];
  for (const sc of starterChats) {
    if (db.users[sc.botId] && sc.botId !== userId) {
      const convId = [userId, sc.botId].sort().join('_');
      const hasConv = db.messages.some((m) => m.conversation_id === convId);
      if (!hasConv) {
        db.messages.push({
          id: `msg-seed-${userId}-${sc.botId}`,
          conversation_id: convId,
          sender_id: sc.botId,
          receiver_id: userId,
          content: sc.text,
          created_at: new Date(Date.now() - sc.minsAgo * 60000).toISOString(),
          read: false,
        });
      }
    }
  }

  // Ensure starter match history if user has none
  const userHistory = db.match_history.filter((m) => m.user_id === userId);
  if (userHistory.length === 0) {
    db.match_history.push(
      {
        id: `mh-1-${userId}`,
        user_id: userId,
        opponent_name: 'SaraQueen',
        opponent_avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
        game_type: 'chess',
        result: 'Won',
        time_ago: '2h',
        created_at: new Date(Date.now() - 2 * 3600000).toISOString(),
      },
      {
        id: `mh-2-${userId}`,
        user_id: userId,
        opponent_name: 'GamingPro',
        opponent_avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80',
        game_type: 'ttt',
        result: 'Draw',
        time_ago: '4h',
        created_at: new Date(Date.now() - 4 * 3600000).toISOString(),
      },
      {
        id: `mh-3-${userId}`,
        user_id: userId,
        opponent_name: 'AlexR',
        opponent_avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80',
        game_type: 'chess',
        result: 'Won',
        time_ago: '1d',
        created_at: new Date(Date.now() - 24 * 3600000).toISOString(),
      }
    );
  }
}

function loadDb() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const content = fs.readFileSync(DB_FILE, 'utf-8');
      db = JSON.parse(content);
      if (!db.match_history) db.match_history = [];
    } catch (err) {
      console.error('Error reading DB, re-seeding...', err);
    }
  }

  // Always ensure all default bots exist
  for (const bot of DEFAULT_BOTS) {
    if (!db.users[bot.id]) {
      const salt = crypto.randomBytes(16).toString('hex');
      const password_hash = hashPassword('chessverse123', salt);
      db.users[bot.id] = {
        id: bot.id,
        username: bot.username,
        username_normalized: bot.username.toLowerCase(),
        public_uid: bot.public_uid,
        password_hash,
        salt,
        avatar_url: bot.avatar_url,
        status_text: bot.status_text,
        created_at: new Date().toISOString(),
        stats: bot.stats,
        privacy_settings: { show_online: true, allow_invites: true },
      };
    } else {
      db.users[bot.id].status_text = bot.status_text;
      db.users[bot.id].avatar_url = bot.avatar_url;
    }
  }

  // Ensure existing human users and demo account Grandmaster_Magnus have seeded friends/messages/history
  for (const user of Object.values(db.users)) {
    if (!user.id.startsWith('bot-') || user.id === 'bot-magnus') {
      ensureUserSeededData(user.id);
    }
  }

  saveDb();
}

loadDb();

// ----------------------------------------------------
// TOKEN SESSIONS
// ----------------------------------------------------
const sessions: Record<string, { userId: string; createdAt: number }> = {};

function createSession(userId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { userId, createdAt: Date.now() };
  return token;
}

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: missing token' });
    return;
  }
  const token = authHeader.split(' ')[1];
  const session = sessions[token];
  if (!session || !db.users[session.userId]) {
    res.status(401).json({ error: 'Unauthorized: invalid or expired session' });
    return;
  }
  (req as any).user = db.users[session.userId];
  next();
}

function isUserOnline(userId: string): boolean {
  if (userId.startsWith('bot-')) return true; // Community bots are always online & ready
  return activeSockets.has(userId);
}

// ----------------------------------------------------
// EXPRESS APP SETUP
// ----------------------------------------------------
const app = express();
app.use(express.json());

// Enable CORS for cross-origin frontend requests (e.g., when client is hosted on Vercel)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

const activeSockets: Map<string, Set<WebSocket>> = new Map();
const roomSubscriptions: Map<string, Set<WebSocket>> = new Map();

function getRoomParticipants(room: GameRoomRecord): string[] {
  const set = new Set<string>();
  if (room.player_one_id) set.add(room.player_one_id);
  if (room.player_two_id) set.add(room.player_two_id);
  if (room.player_three_id) set.add(room.player_three_id);
  if (Array.isArray(room.participants)) {
    for (const pid of room.participants) {
      if (pid) set.add(pid);
    }
  }
  return Array.from(set);
}

function isAuthorizedInRoom(room: GameRoomRecord, userId: string): boolean {
  return getRoomParticipants(room).includes(userId);
}

function formatParticipantUser(userId: string | null | undefined, role?: string) {
  if (!userId) return null;
  if (userId === 'ai-opponent') {
    const bot = db.users['bot-saraqueen'];
    return {
      id: 'ai-opponent',
      username: bot?.username || 'SaraQueen (AI)',
      avatar_url:
        bot?.avatar_url ||
        'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
      public_uid: bot?.public_uid || 'CV-4F8Z1Q9L',
      role: role || 'AI',
    };
  }
  const u = db.users[userId];
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    avatar_url: u.avatar_url,
    public_uid: u.public_uid,
    role,
  };
}

function getRoomPlayersPayload(room: GameRoomRecord) {
  const p1 = formatParticipantUser(room.player_one_id, room.player_one_symbol);
  const p2 = formatParticipantUser(room.player_two_id, room.player_two_symbol);
  const p3 = formatParticipantUser(room.player_three_id, room.player_three_symbol || 'P3');
  const participants = getRoomParticipants(room)
    .map((uid, idx) => formatParticipantUser(uid, `P${idx + 1}`))
    .filter((p): p is NonNullable<typeof p> => p !== null);

  return {
    playerOne: p1,
    playerTwo: p2,
    playerThree: p3,
    participants,
  };
}

function sendToUser(userId: string, event: string, payload: any) {
  const sockets = activeSockets.get(userId);
  if (sockets) {
    const msg = JSON.stringify({ type: event, ...payload });
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }
}

function broadcastToRoom(room: GameRoomRecord, event: string, payload: any) {
  const msg = JSON.stringify({ type: event, ...payload });
  const deliveredSockets = new Set<WebSocket>();

  // 1. Deliver to all sockets explicitly subscribed to this roomId
  const roomSubs = roomSubscriptions.get(room.id);
  if (roomSubs) {
    for (const ws of roomSubs) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
        deliveredSockets.add(ws);
      }
    }
  }

  // 2. Deliver to all active sockets of every authorized participant in the room
  const participants = getRoomParticipants(room);
  for (const participantId of participants) {
    if (participantId === 'ai-opponent') continue;
    const userSockets = activeSockets.get(participantId);
    if (userSockets) {
      for (const ws of userSockets) {
        if (ws.readyState === WebSocket.OPEN && !deliveredSockets.has(ws)) {
          ws.send(msg);
          deliveredSockets.add(ws);
        }
      }
    }
  }
}

function broadcastPresence(userId: string, isOnline: boolean) {
  const user = db.users[userId];
  if (!user) return;
  const msg = JSON.stringify({
    type: 'presence',
    userId,
    username: user.username,
    isOnline,
    lastSeen: new Date().toISOString(),
  });

  for (const [, sockets] of activeSockets.entries()) {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }
}

wss.on('connection', (ws) => {
  let authenticatedUserId: string | null = null;
  const socketRooms = new Set<string>();

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth') {
        const session = sessions[msg.token];
        if (session && db.users[session.userId]) {
          authenticatedUserId = session.userId;
          if (!activeSockets.has(authenticatedUserId)) {
            activeSockets.set(authenticatedUserId, new Set());
          }
          activeSockets.get(authenticatedUserId)!.add(ws);

          ws.send(JSON.stringify({ type: 'auth_success', userId: authenticatedUserId }));
          broadcastPresence(authenticatedUserId, true);
        } else {
          ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
        }
      } else if (msg.type === 'join_room' && authenticatedUserId && msg.roomId) {
        const room = db.game_rooms[msg.roomId];
        if (room && isAuthorizedInRoom(room, authenticatedUserId)) {
          if (!roomSubscriptions.has(room.id)) {
            roomSubscriptions.set(room.id, new Set());
          }
          roomSubscriptions.get(room.id)!.add(ws);
          socketRooms.add(room.id);
          ws.send(
            JSON.stringify({
              type: 'room_subscribed',
              roomId: room.id,
              room,
              players: getRoomPlayersPayload(room),
            })
          );
        } else {
          ws.send(
            JSON.stringify({
              type: 'room_error',
              roomId: msg.roomId,
              error: 'Unauthorized room subscription denied',
            })
          );
        }
      } else if (msg.type === 'leave_room' && msg.roomId) {
        const subs = roomSubscriptions.get(msg.roomId);
        if (subs) {
          subs.delete(ws);
          if (subs.size === 0) roomSubscriptions.delete(msg.roomId);
        }
        socketRooms.delete(msg.roomId);
      } else if (msg.type === 'typing' && authenticatedUserId && msg.receiverId) {
        sendToUser(msg.receiverId, 'typing', {
          senderId: authenticatedUserId,
          isTyping: msg.isTyping,
        });
      } else if (msg.type === 'board_highlight' && authenticatedUserId && msg.roomId) {
        const room = db.game_rooms[msg.roomId];
        if (room && isAuthorizedInRoom(room, authenticatedUserId)) {
          broadcastToRoom(room, 'board_highlight', {
            roomId: room.id,
            userId: authenticatedUserId,
            squares: Array.isArray(msg.squares) ? msg.squares : null,
          });
        }
      }
    } catch (err) {
      console.error('WS message error:', err);
    }
  });

  ws.on('close', () => {
    for (const roomId of socketRooms) {
      const subs = roomSubscriptions.get(roomId);
      if (subs) {
        subs.delete(ws);
        if (subs.size === 0) roomSubscriptions.delete(roomId);
      }
    }
    socketRooms.clear();

    if (authenticatedUserId) {
      const userSockets = activeSockets.get(authenticatedUserId);
      if (userSockets) {
        userSockets.delete(ws);
        if (userSockets.size === 0) {
          activeSockets.delete(authenticatedUserId);
          broadcastPresence(authenticatedUserId, false);
        }
      }
    }
  });
});

// ----------------------------------------------------
// REST ROUTES
// ----------------------------------------------------

// Register (Username + Password only, server generates UID)
app.post('/api/auth/register', (req: Request, res: Response): void => {
  const { username, password } = req.body;
  if (!username || typeof username !== 'string' || username.trim().length < 3) {
    res.status(400).json({ error: 'Username must be at least 3 characters long.' });
    return;
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    return;
  }

  const normalized = username.trim().toLowerCase();
  const exists = Object.values(db.users).some((u) => u.username_normalized === normalized);
  if (exists) {
    res.status(409).json({ error: 'Username is already taken. Please choose another.' });
    return;
  }

  let public_uid = generatePublicUID();
  while (Object.values(db.users).some((u) => u.public_uid === public_uid)) {
    public_uid = generatePublicUID();
  }

  const id = `user-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const salt = crypto.randomBytes(16).toString('hex');
  const password_hash = hashPassword(password, salt);
  const avatar_url = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username.trim())}`;

  const newUser: UserRecord = {
    id,
    username: username.trim(),
    username_normalized: normalized,
    public_uid,
    password_hash,
    salt,
    avatar_url,
    created_at: new Date().toISOString(),
    stats: {
      chess: { wins: 12, losses: 4, draws: 3, rating: 1450 },
      ttt: { wins: 15, losses: 3, draws: 2 },
    },
    privacy_settings: {
      show_online: true,
      allow_invites: true,
    },
  };

  db.users[id] = newUser;
  ensureUserSeededData(id);
  saveDb();

  const token = createSession(id);
  const { password_hash: _, salt: __, ...safeUser } = newUser;
  res.status(201).json({ user: safeUser, token });
});

// Login (Username + Password only)
app.post('/api/auth/login', (req: Request, res: Response): void => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required.' });
    return;
  }

  const normalized = username.trim().toLowerCase();
  const user = Object.values(db.users).find((u) => u.username_normalized === normalized);
  if (!user) {
    res.status(401).json({ error: 'Invalid username or password.' });
    return;
  }

  const calculatedHash = hashPassword(password, user.salt);
  if (calculatedHash !== user.password_hash) {
    res.status(401).json({ error: 'Invalid username or password.' });
    return;
  }

  ensureUserSeededData(user.id);
  saveDb();

  const token = createSession(user.id);
  const { password_hash: _, salt: __, ...safeUser } = user;
  res.json({ user: safeUser, token });
});

// Current User Profile
app.get('/api/auth/me', authMiddleware, (req: Request, res: Response): void => {
  const user = (req as any).user as UserRecord;
  ensureUserSeededData(user.id);
  const { password_hash: _, salt: __, ...safeUser } = user;
  res.json({ user: safeUser });
});

// Update Profile / Username / Password
app.patch('/api/auth/profile', authMiddleware, (req: Request, res: Response): void => {
  const user = (req as any).user as UserRecord;
  const { avatar_url, privacy_settings, new_username, new_password } = req.body;

  if (new_username && typeof new_username === 'string') {
    const trimmed = new_username.trim();
    if (trimmed.length < 3) {
      res.status(400).json({ error: 'Username must be at least 3 characters.' });
      return;
    }
    const norm = trimmed.toLowerCase();
    const conflict = Object.values(db.users).some(
      (u) => u.id !== user.id && u.username_normalized === norm
    );
    if (conflict) {
      res.status(409).json({ error: 'That username is already taken.' });
      return;
    }
    user.username = trimmed;
    user.username_normalized = norm;
  }

  if (new_password && typeof new_password === 'string') {
    if (new_password.length < 6) {
      res.status(400).json({ error: 'New password must be at least 6 characters.' });
      return;
    }
    user.password_hash = hashPassword(new_password, user.salt);
  }

  if (avatar_url && typeof avatar_url === 'string') {
    user.avatar_url = avatar_url;
  }
  if (privacy_settings) {
    user.privacy_settings = { ...user.privacy_settings, ...privacy_settings };
  }

  saveDb();
  const { password_hash: _, salt: __, ...safeUser } = user;
  res.json({ user: safeUser });
});

// Delete Account
app.delete('/api/auth/delete', authMiddleware, (req: Request, res: Response): void => {
  const user = (req as any).user as UserRecord;
  delete db.users[user.id];

  db.friendships = db.friendships.filter(
    (f) => f.requester_id !== user.id && f.receiver_id !== user.id
  );
  db.invitations = db.invitations.filter(
    (inv) => inv.inviter_id !== user.id && inv.invitee_id !== user.id
  );
  db.messages = db.messages.filter(
    (m) => m.sender_id !== user.id && m.receiver_id !== user.id
  );

  saveDb();
  res.json({ success: true, message: 'Account deleted successfully' });
});

// Match History
app.get('/api/matches/history', authMiddleware, (req: Request, res: Response): void => {
  const user = (req as any).user as UserRecord;
  const history = (db.match_history || [])
    .filter((m) => m.user_id === user.id)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 10);
  res.json({ history });
});

// Consolidated Bootstrap Endpoint (prevents burst HTTP 429 from parallel client requests)
app.get('/api/bootstrap', authMiddleware, (req: Request, res: Response): void => {
  const user = (req as any).user as UserRecord;
  const userId = user.id;
  ensureUserSeededData(userId);

  // 1. Invitations
  const invitations = db.invitations
    .filter((inv) => inv.invitee_id === userId && inv.status === 'pending')
    .map((inv) => {
      const inviter = db.users[inv.inviter_id];
      return {
        ...inv,
        inviter: inviter
          ? {
              id: inviter.id,
              username: inviter.username,
              public_uid: inviter.public_uid,
              avatar_url: inviter.avatar_url,
            }
          : null,
      };
    });

  // 2. Friends & Pending Requests
  const friendRecords = db.friendships.filter(
    (f) => (f.requester_id === userId || f.receiver_id === userId) && f.status === 'accepted'
  );
  const friends = friendRecords.map((f) => {
    const friendId = f.requester_id === userId ? f.receiver_id : f.requester_id;
    const friendUser = db.users[friendId] || {
      id: friendId,
      username: 'Player',
      public_uid: 'CV-UNKNOWN',
      avatar_url: '',
      status_text: 'Online',
      stats: {
        chess: { wins: 0, losses: 0, draws: 0, rating: 1200 },
        ttt: { wins: 0, losses: 0, draws: 0 },
      },
    };
    return {
      friendshipId: f.id,
      id: friendUser.id,
      username: friendUser.username,
      public_uid: friendUser.public_uid,
      avatar_url: friendUser.avatar_url,
      status_text: friendUser.status_text || 'Online',
      stats: friendUser.stats,
      isOnline: isUserOnline(friendUser.id),
    };
  });

  const pendingRequests = db.friendships
    .filter((f) => f.receiver_id === userId && f.status === 'pending')
    .map((f) => {
      const requester = db.users[f.requester_id];
      return {
        friendshipId: f.id,
        requester: requester
          ? {
              id: requester.id,
              username: requester.username,
              public_uid: requester.public_uid,
              avatar_url: requester.avatar_url,
            }
          : null,
      };
    })
    .filter((r) => r.requester !== null);

  // 3. Conversations
  const participantIds = new Set<string>();
  for (const msg of db.messages) {
    if (msg.sender_id === userId) participantIds.add(msg.receiver_id);
    if (msg.receiver_id === userId) participantIds.add(msg.sender_id);
  }
  for (const f of db.friendships) {
    if (f.status === 'accepted') {
      if (f.requester_id === userId) participantIds.add(f.receiver_id);
      if (f.receiver_id === userId) participantIds.add(f.requester_id);
    }
  }
  const conversations = Array.from(participantIds)
    .map((otherId) => {
      const otherUser = db.users[otherId] || {
        id: otherId,
        username: 'User',
        public_uid: 'CV-UNKNOWN',
        avatar_url: '',
        status_text: 'Online',
      };
      const convId = getConversationId(userId, otherId);
      const convMessages = db.messages.filter((m) => m.conversation_id === convId);
      const lastMessage = convMessages[convMessages.length - 1] || null;
      const unreadCount = convMessages.filter((m) => m.receiver_id === userId && !m.read).length;

      return {
        conversationId: convId,
        contact: {
          id: otherUser.id,
          username: otherUser.username,
          public_uid: otherUser.public_uid,
          avatar_url: otherUser.avatar_url,
          status_text: (otherUser as any).status_text || 'Online',
          isOnline: isUserOnline(otherUser.id),
        },
        lastMessage,
        unreadCount,
      };
    })
    .sort((a, b) => {
      const timeA = a.lastMessage ? new Date(a.lastMessage.created_at).getTime() : 0;
      const timeB = b.lastMessage ? new Date(b.lastMessage.created_at).getTime() : 0;
      return timeB - timeA;
    });

  // 4. Leaderboard
  const topChess = Object.values(db.users)
    .map((u) => ({
      id: u.id,
      username: u.username,
      public_uid: u.public_uid,
      avatar_url: u.avatar_url,
      stats: u.stats,
      rating: u.stats.chess.rating,
      wins: u.stats.chess.wins,
      losses: u.stats.chess.losses,
      draws: u.stats.chess.draws,
      isOnline: isUserOnline(u.id),
    }))
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 10);

  const topTTT = Object.values(db.users)
    .map((u) => ({
      id: u.id,
      username: u.username,
      public_uid: u.public_uid,
      avatar_url: u.avatar_url,
      stats: u.stats,
      wins: u.stats.ttt.wins,
      losses: u.stats.ttt.losses,
      draws: u.stats.ttt.draws,
      isOnline: isUserOnline(u.id),
    }))
    .sort((a, b) => b.wins - a.wins)
    .slice(0, 10);

  // 5. Match History
  const history = (db.match_history || [])
    .filter((m) => m.user_id === userId)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 10);

  const { password_hash: _, salt: __, ...safeUser } = user;
  res.json({
    user: safeUser,
    invitations,
    friends,
    pendingRequests,
    conversations,
    leaderboard: { chess: topChess, ttt: topTTT },
    history,
  });
});

// Search users by exact username or UID or prefix
app.get('/api/users/search', authMiddleware, (req: Request, res: Response): void => {
  const query = ((req.query.q as string) || '').trim().toLowerCase();
  const currentUserId = (req as any).user.id;

  if (!query) {
    res.json({ users: [] });
    return;
  }

  const results = Object.values(db.users)
    .filter((u) => u.id !== currentUserId)
    .filter(
      (u) =>
        u.username_normalized.includes(query) ||
        u.public_uid.toLowerCase() === query ||
        u.public_uid.toLowerCase().includes(query)
    )
    .slice(0, 10)
    .map((u) => ({
      id: u.id,
      username: u.username,
      public_uid: u.public_uid,
      avatar_url: u.avatar_url,
      status_text: u.status_text || 'Online',
      stats: u.stats,
      isOnline: isUserOnline(u.id),
    }));

  res.json({ users: results });
});

// User profile by ID
app.get('/api/users/:userId', authMiddleware, (req: Request, res: Response): void => {
  const u = db.users[req.params.userId];
  if (!u) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({
    user: {
      id: u.id,
      username: u.username,
      public_uid: u.public_uid,
      avatar_url: u.avatar_url,
      status_text: u.status_text || 'Online',
      created_at: u.created_at,
      stats: u.stats,
      isOnline: isUserOnline(u.id),
    },
  });
});

// Leaderboard
app.get('/api/leaderboard', (_req: Request, res: Response): void => {
  const topChess = Object.values(db.users)
    .map((u) => ({
      id: u.id,
      username: u.username,
      public_uid: u.public_uid,
      avatar_url: u.avatar_url,
      stats: u.stats,
      rating: u.stats.chess.rating,
      wins: u.stats.chess.wins,
      losses: u.stats.chess.losses,
      draws: u.stats.chess.draws,
      isOnline: isUserOnline(u.id),
    }))
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 10);

  const topTTT = Object.values(db.users)
    .map((u) => ({
      id: u.id,
      username: u.username,
      public_uid: u.public_uid,
      avatar_url: u.avatar_url,
      stats: u.stats,
      wins: u.stats.ttt.wins,
      losses: u.stats.ttt.losses,
      draws: u.stats.ttt.draws,
      isOnline: isUserOnline(u.id),
    }))
    .sort((a, b) => b.wins - a.wins)
    .slice(0, 10);

  res.json({ chess: topChess, ttt: topTTT });
});

// ----------------------------------------------------
// FRIENDSHIPS
// ----------------------------------------------------
app.get('/api/friends', authMiddleware, (req: Request, res: Response): void => {
  const userId = (req as any).user.id;
  const friendRecords = db.friendships.filter(
    (f) => (f.requester_id === userId || f.receiver_id === userId) && f.status === 'accepted'
  );

  const friends = friendRecords.map((f) => {
    const friendId = f.requester_id === userId ? f.receiver_id : f.requester_id;
    const friendUser = db.users[friendId] || {
      id: friendId,
      username: 'Player',
      public_uid: 'CV-UNKNOWN',
      avatar_url: '',
      status_text: 'Online',
      stats: { chess: { wins: 0, losses: 0, draws: 0, rating: 1200 }, ttt: { wins: 0, losses: 0, draws: 0 } },
    };
    return {
      friendshipId: f.id,
      id: friendUser.id,
      username: friendUser.username,
      public_uid: friendUser.public_uid,
      avatar_url: friendUser.avatar_url,
      status_text: friendUser.status_text || 'Online',
      stats: friendUser.stats,
      isOnline: isUserOnline(friendUser.id),
    };
  });

  const pendingRequests = db.friendships
    .filter((f) => f.receiver_id === userId && f.status === 'pending')
    .map((f) => {
      const requester = db.users[f.requester_id];
      return {
        friendshipId: f.id,
        requester: requester
          ? {
              id: requester.id,
              username: requester.username,
              public_uid: requester.public_uid,
              avatar_url: requester.avatar_url,
            }
          : null,
      };
    })
    .filter((r) => r.requester !== null);

  res.json({ friends, pendingRequests });
});

app.post('/api/friends/request', authMiddleware, (req: Request, res: Response): void => {
  const userId = (req as any).user.id;
  const { targetUserId } = req.body;

  if (!targetUserId || targetUserId === userId) {
    res.status(400).json({ error: 'Invalid friend request target.' });
    return;
  }

  // Allow searching by username or UID if targetUserId isn't a raw ID
  let resolvedTargetId = targetUserId;
  if (!db.users[resolvedTargetId]) {
    const found = Object.values(db.users).find(
      (u) =>
        u.username_normalized === targetUserId.toLowerCase() ||
        u.public_uid.toLowerCase() === targetUserId.toLowerCase()
    );
    if (found) resolvedTargetId = found.id;
  }

  if (!db.users[resolvedTargetId]) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  const existing = db.friendships.find(
    (f) =>
      (f.requester_id === userId && f.receiver_id === resolvedTargetId) ||
      (f.requester_id === resolvedTargetId && f.receiver_id === userId)
  );

  if (existing) {
    if (existing.status === 'accepted') {
      res.status(400).json({ error: 'You are already friends with this user.' });
      return;
    }
    if (existing.status === 'pending') {
      res.status(400).json({ error: 'A friendship request is already pending.' });
      return;
    }
  }

  const friendship: FriendshipRecord = {
    id: `fr-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    requester_id: userId,
    receiver_id: resolvedTargetId,
    status: resolvedTargetId.startsWith('bot-') ? 'accepted' : 'pending',
    created_at: new Date().toISOString(),
  };

  db.friendships.push(friendship);
  saveDb();

  sendToUser(resolvedTargetId, 'friend_request', {
    friendshipId: friendship.id,
    from: (req as any).user,
  });

  res.status(201).json({ success: true, friendship });
});

app.post('/api/friends/respond', authMiddleware, (req: Request, res: Response): void => {
  const userId = (req as any).user.id;
  const { friendshipId, action } = req.body;

  const fr = db.friendships.find((f) => f.id === friendshipId && f.receiver_id === userId);
  if (!fr) {
    res.status(404).json({ error: 'Friend request not found.' });
    return;
  }

  if (action === 'accept') {
    fr.status = 'accepted';
    sendToUser(fr.requester_id, 'friend_accepted', {
      user: (req as any).user,
    });
  } else {
    fr.status = 'declined';
  }

  saveDb();
  res.json({ success: true, status: fr.status });
});

// ----------------------------------------------------
// WHATSAPP-INSPIRED PRIVATE MESSAGING
// ----------------------------------------------------
function getConversationId(userId1: string, userId2: string): string {
  return [userId1, userId2].sort().join('_');
}

app.get('/api/chat/conversations', authMiddleware, (req: Request, res: Response): void => {
  const userId = (req as any).user.id;

  const participantIds = new Set<string>();
  for (const msg of db.messages) {
    if (msg.sender_id === userId) participantIds.add(msg.receiver_id);
    if (msg.receiver_id === userId) participantIds.add(msg.sender_id);
  }

  for (const f of db.friendships) {
    if (f.status === 'accepted') {
      if (f.requester_id === userId) participantIds.add(f.receiver_id);
      if (f.receiver_id === userId) participantIds.add(f.requester_id);
    }
  }

  const conversations = Array.from(participantIds).map((otherId) => {
    const otherUser = db.users[otherId] || {
      id: otherId,
      username: 'User',
      public_uid: 'CV-UNKNOWN',
      avatar_url: '',
      status_text: 'Online',
    };
    const convId = getConversationId(userId, otherId);
    const convMessages = db.messages.filter((m) => m.conversation_id === convId);
    const lastMessage = convMessages[convMessages.length - 1] || null;
    const unreadCount = convMessages.filter((m) => m.receiver_id === userId && !m.read).length;

    return {
      conversationId: convId,
      contact: {
        id: otherUser.id,
        username: otherUser.username,
        public_uid: otherUser.public_uid,
        avatar_url: otherUser.avatar_url,
        status_text: (otherUser as any).status_text || 'Online',
        isOnline: isUserOnline(otherUser.id),
      },
      lastMessage,
      unreadCount,
    };
  });

  conversations.sort((a, b) => {
    const timeA = a.lastMessage ? new Date(a.lastMessage.created_at).getTime() : 0;
    const timeB = b.lastMessage ? new Date(b.lastMessage.created_at).getTime() : 0;
    return timeB - timeA;
  });

  res.json({ conversations });
});

app.get('/api/chat/messages/:otherUserId', authMiddleware, (req: Request, res: Response): void => {
  const userId = (req as any).user.id;
  const otherUserId = req.params.otherUserId;
  const convId = getConversationId(userId, otherUserId);

  for (const m of db.messages) {
    if (m.conversation_id === convId && m.receiver_id === userId) {
      m.read = true;
    }
  }
  saveDb();

  const messages = db.messages.filter((m) => m.conversation_id === convId);
  res.json({ messages });
});

app.post('/api/chat/send', authMiddleware, (req: Request, res: Response): void => {
  const user = (req as any).user as UserRecord;
  const userId = user.id;
  const { receiverId, content } = req.body;

  if (!receiverId || !content || !content.trim()) {
    res.status(400).json({ error: 'Receiver ID and content are required.' });
    return;
  }

  if (content.length > 1000) {
    res.status(400).json({ error: 'Message cannot exceed 1000 characters.' });
    return;
  }

  // Resolve receiverId by id, public_uid, or username
  let resolvedReceiverId = receiverId;
  if (!db.users[resolvedReceiverId]) {
    const found = Object.values(db.users).find(
      (u) =>
        u.public_uid.toLowerCase() === String(receiverId).trim().toLowerCase() ||
        u.username_normalized === String(receiverId).trim().toLowerCase()
    );
    if (found) resolvedReceiverId = found.id;
  }

  if (!db.users[resolvedReceiverId]) {
    res.status(404).json({ error: 'Recipient user not found.' });
    return;
  }

  const convId = getConversationId(userId, resolvedReceiverId);
  const newMsg: MessageRecord = {
    id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    conversation_id: convId,
    sender_id: userId,
    receiver_id: resolvedReceiverId,
    content: content.trim(),
    created_at: new Date().toISOString(),
    read: false,
  };

  db.messages.push(newMsg);
  saveDb();

  // Deliver to recipient and sender's other tabs in real time (NO automatic bot replies)
  sendToUser(resolvedReceiverId, 'new_message', { message: newMsg });
  sendToUser(userId, 'new_message', { message: newMsg });

  res.status(201).json({ message: newMsg });
});

// ----------------------------------------------------
// GAME INVITATIONS & ROOMS (2-PLAYER & 3-PLAYER SUPPORT + STRICT ACCESS CONTROL)
// ----------------------------------------------------
app.get('/api/invitations', authMiddleware, (req: Request, res: Response): void => {
  const userId = (req as any).user.id;
  const incoming = db.invitations
    .filter((inv) => inv.invitee_id === userId && inv.status === 'pending')
    .map((inv) => {
      const inviter = db.users[inv.inviter_id];
      return {
        ...inv,
        inviter: inviter
          ? {
              id: inviter.id,
              username: inviter.username,
              public_uid: inviter.public_uid,
              avatar_url: inviter.avatar_url,
            }
          : null,
      };
    });

  res.json({ invitations: incoming });
});

app.post('/api/invitations/send', authMiddleware, (req: Request, res: Response): void => {
  const userId = (req as any).user.id;
  const { inviteeId, gameType, maxPlayers } = req.body;

  if (!inviteeId) {
    res.status(400).json({ error: 'Invalid invitee.' });
    return;
  }

  // Allow inviting by user ID, public UID (e.g. CV-XXXXXXXX), or username
  let resolvedInviteeId = String(inviteeId).trim();
  if (!db.users[resolvedInviteeId]) {
    const found = Object.values(db.users).find(
      (u) =>
        u.public_uid.toLowerCase() === resolvedInviteeId.toLowerCase() ||
        u.username_normalized === resolvedInviteeId.toLowerCase()
    );
    if (found) resolvedInviteeId = found.id;
  }

  if (!db.users[resolvedInviteeId] || resolvedInviteeId === userId) {
    res.status(404).json({ error: 'Target player not found or invalid.' });
    return;
  }

  const roomMaxPlayers: 2 | 3 = maxPlayers === 3 ? 3 : 2;
  const prefix = gameType === 'ttt' ? 'TT-' : '7A';
  const roomCode = `${prefix}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  const roomId = `room-${Date.now()}-${roomCode}`;

  let initialGameState: any = null;
  if (gameType === 'chess') {
    const chess = new Chess();
    initialGameState = {
      ...getChessState(chess),
      whiteTime: 600,
      blackTime: 600,
      lastTurnAt: Date.now(),
      lastMove: null,
    };
  } else {
    initialGameState = {
      board: Array(9).fill(null),
      winningLine: null,
      isGameOver: false,
    };
  }

  // Note: bot-magnus is a real demo account that can be logged into in a browser tab!
  const isPureBotInvitee =
    resolvedInviteeId.startsWith('bot-') &&
    resolvedInviteeId !== 'bot-magnus' &&
    !activeSockets.has(resolvedInviteeId);

  const room: GameRoomRecord = {
    id: roomId,
    room_code: roomCode,
    game_type: gameType || 'chess',
    mode: isPureBotInvitee ? 'ai' : 'online',
    max_players: roomMaxPlayers,
    participants: [userId, resolvedInviteeId],
    player_one_id: userId,
    player_two_id: resolvedInviteeId,
    player_three_id: null,
    player_one_symbol: gameType === 'chess' ? 'w' : 'X',
    player_two_symbol: gameType === 'chess' ? 'b' : 'O',
    player_three_symbol: 'S',
    current_turn: gameType === 'chess' ? 'w' : 'X',
    game_state: initialGameState,
    state_version: 1,
    winner_id: null,
    status: isPureBotInvitee ? 'active' : 'waiting',
    move_history: [],
    chat_messages: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  db.game_rooms[roomId] = room;

  const invitation: GameInvitationRecord = {
    id: `inv-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    inviter_id: userId,
    invitee_id: resolvedInviteeId,
    game_type: gameType || 'chess',
    status: isPureBotInvitee ? 'accepted' : 'pending',
    room_id: roomId,
    created_at: new Date().toISOString(),
  };

  db.invitations.push(invitation);
  saveDb();

  // Deliver the invitation ONLY to the intended invitee account
  if (!isPureBotInvitee) {
    sendToUser(resolvedInviteeId, 'game_invitation', {
      invitation: {
        ...invitation,
        inviter: (req as any).user,
      },
    });
  }

  res.status(201).json({ invitation, room });
});

app.post('/api/invitations/respond', authMiddleware, (req: Request, res: Response): void => {
  const userId = (req as any).user.id;
  const { invitationId, action } = req.body;

  const inv = db.invitations.find((i) => i.id === invitationId);
  if (!inv) {
    res.status(404).json({ error: 'Invitation not found.' });
    return;
  }

  if (inv.invitee_id !== userId) {
    res.status(403).json({ error: 'Access denied: This invitation belongs to another player.' });
    return;
  }

  const room = db.game_rooms[inv.room_id];

  if (action === 'accept') {
    inv.status = 'accepted';
    if (room) {
      if (!room.player_two_id || room.player_two_id === userId) {
        room.player_two_id = userId;
      } else if (room.max_players === 3 && !room.player_three_id) {
        room.player_three_id = userId;
      }
      room.participants = getRoomParticipants(room);
      if (!room.participants.includes(userId)) {
        room.participants.push(userId);
      }
      room.status = 'active';
      if (room.game_type === 'chess' && room.game_state) {
        room.game_state.lastTurnAt = Date.now();
      }
      room.updated_at = new Date().toISOString();
    }

    const playersPayload = room ? getRoomPlayersPayload(room) : undefined;

    sendToUser(inv.inviter_id, 'invitation_accepted', {
      invitationId,
      roomId: inv.room_id,
      gameType: inv.game_type,
      accepter: (req as any).user,
      room,
      players: playersPayload,
    });

    if (room) {
      broadcastToRoom(room, 'game_update', {
        roomId: room.id,
        room,
        players: playersPayload,
      });
    }
  } else {
    inv.status = 'declined';
    sendToUser(inv.inviter_id, 'invitation_declined', {
      invitationId,
      roomId: inv.room_id,
    });
  }

  saveDb();
  res.json({ success: true, status: inv.status, roomId: inv.room_id, room });
});

// Create Public or Private Game Room directly (Supports 2-Player and 3-Player rooms)
app.post('/api/rooms/create', authMiddleware, (req: Request, res: Response): void => {
  const userId = (req as any).user.id;
  const { gameType, mode, maxPlayers } = req.body;

  const roomMaxPlayers: 2 | 3 = maxPlayers === 3 ? 3 : 2;
  const prefix = gameType === 'ttt' ? 'TT-' : roomMaxPlayers === 3 ? '3P-' : '7A';
  const roomCode = `${prefix}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  const roomId = `room-${Date.now()}-${roomCode}`;

  let initialGameState: any = null;
  if (gameType === 'chess') {
    const chess = new Chess();
    initialGameState = {
      ...getChessState(chess),
      whiteTime: 600,
      blackTime: 600,
      lastTurnAt: Date.now(),
      lastMove: null,
    };
  } else {
    initialGameState = {
      board: Array(9).fill(null),
      winningLine: null,
      isGameOver: false,
    };
  }

  const initialParticipants = [userId];
  if (mode === 'ai') {
    initialParticipants.push('bot-saraqueen');
  }

  const room: GameRoomRecord = {
    id: roomId,
    room_code: roomCode,
    game_type: gameType || 'chess',
    mode: mode || 'online',
    max_players: roomMaxPlayers,
    participants: initialParticipants,
    player_one_id: userId,
    player_two_id: mode === 'ai' ? 'bot-saraqueen' : null,
    player_three_id: null,
    player_one_symbol: gameType === 'chess' ? 'w' : 'X',
    player_two_symbol: gameType === 'chess' ? 'b' : 'O',
    player_three_symbol: 'S',
    current_turn: gameType === 'chess' ? 'w' : 'X',
    game_state: initialGameState,
    state_version: 1,
    winner_id: null,
    status: mode === 'ai' ? 'active' : 'waiting',
    move_history: [],
    chat_messages: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  db.game_rooms[roomId] = room;
  saveDb();

  res.status(201).json({ room, players: getRoomPlayersPayload(room) });
});

// Join Room by Code (Supports 2-Player and 3-Player rooms with capacity enforcement)
app.post('/api/rooms/join', authMiddleware, (req: Request, res: Response): void => {
  const userId = (req as any).user.id;
  const { roomCode } = req.body;

  if (!roomCode) {
    res.status(400).json({ error: 'Room code is required.' });
    return;
  }

  const cleanCode = String(roomCode).trim().toUpperCase().replace(/^#/, '');
  const room = Object.values(db.game_rooms).find(
    (r) => r.room_code.toUpperCase() === cleanCode || r.id === String(roomCode).trim()
  );

  if (!room) {
    res.status(404).json({ error: 'Room not found with code: ' + roomCode });
    return;
  }

  const maxAllowed = room.max_players || 2;
  const existingParticipants = getRoomParticipants(room);

  if (!existingParticipants.includes(userId)) {
    if (!room.player_two_id) {
      room.player_two_id = userId;
    } else if (maxAllowed === 3 && !room.player_three_id) {
      room.player_three_id = userId;
    } else if (existingParticipants.length < maxAllowed) {
      // Slot available in participants
    } else {
      res.status(403).json({
        error: `Access denied: This ${maxAllowed}-player room is already full.`,
      });
      return;
    }

    room.participants = Array.from(new Set([...getRoomParticipants(room), userId]));
    // Activate room as soon as at least 2 players have joined
    if (room.player_one_id && room.player_two_id) {
      room.status = 'active';
      if (room.game_type === 'chess' && room.game_state) {
        room.game_state.lastTurnAt = Date.now();
      }
    }
    room.updated_at = new Date().toISOString();
    saveDb();

    const playersPayload = getRoomPlayersPayload(room);

    broadcastToRoom(room, 'player_joined', {
      roomId: room.id,
      joinedUser: (req as any).user,
      playerTwo: playersPayload.playerTwo,
      playerThree: playersPayload.playerThree,
      players: playersPayload,
      room,
    });

    broadcastToRoom(room, 'game_update', {
      roomId: room.id,
      room,
      players: playersPayload,
    });
  }

  res.json({ room, players: getRoomPlayersPayload(room) });
});

// Get Room State (Strictly restricted to authorized room members)
app.get('/api/rooms/:roomId', authMiddleware, (req: Request, res: Response): void => {
  const userId = (req as any).user.id;
  const room = db.game_rooms[req.params.roomId];
  if (!room) {
    res.status(404).json({ error: 'Room not found.' });
    return;
  }

  if (!isAuthorizedInRoom(room, userId)) {
    res.status(403).json({
      error: 'Access denied: You are not an authorized participant of this room.',
    });
    return;
  }

  res.json({
    room,
    players: getRoomPlayersPayload(room),
  });
});

// Get Persisted Room Chat Messages (Strictly restricted to authorized room members)
app.get('/api/rooms/:roomId/messages', authMiddleware, (req: Request, res: Response): void => {
  const userId = (req as any).user.id;
  const room = db.game_rooms[req.params.roomId];
  if (!room) {
    res.status(404).json({ error: 'Room not found.' });
    return;
  }

  if (!isAuthorizedInRoom(room, userId)) {
    res.status(403).json({
      error: 'Access denied: You are not an authorized participant of this room.',
    });
    return;
  }

  res.json({
    roomId: room.id,
    messages: room.chat_messages || [],
  });
});

// Authoritative Move Submission
app.post('/api/rooms/:roomId/move', authMiddleware, (req: Request, res: Response): void => {
  const userId = (req as any).user.id;
  const room = db.game_rooms[req.params.roomId];
  if (!room) {
    res.status(404).json({ error: 'Room not found.' });
    return;
  }

  if (!isAuthorizedInRoom(room, userId)) {
    res.status(403).json({ error: 'Access denied: You are not a participant in this room.' });
    return;
  }

  if (room.status === 'waiting') {
    res.status(400).json({
      error: 'Waiting for opponent to accept the invitation and join the room.',
    });
    return;
  }

  if (room.status === 'finished') {
    res.status(400).json({ error: 'Game is already finished.' });
    return;
  }

  const isP1 = room.player_one_id === userId;
  const isP2 = room.player_two_id === userId;
  if (!isP1 && !isP2) {
    res.status(403).json({ error: 'Only active board players (Player 1 and Player 2) can make board moves.' });
    return;
  }

  const playerSymbol = isP1 ? room.player_one_symbol : room.player_two_symbol;
  if (room.current_turn !== playerSymbol) {
    res.status(400).json({ error: 'Not your turn!' });
    return;
  }

  const { move } = req.body;

  if (room.game_type === 'ttt') {
    const cellIdx = Number(move);
    const board: TTTBoard = [...room.game_state.board];

    if (!isLegalTTTMove(board, cellIdx)) {
      res.status(400).json({ error: 'Illegal Tic-Tac-Toe move.' });
      return;
    }

    board[cellIdx] = playerSymbol as 'X' | 'O';
    const evaluation = evaluateTTT(board);

    room.game_state = {
      board,
      winningLine: evaluation.winningLine,
      isGameOver: evaluation.isGameOver,
    };
    room.state_version++;
    room.move_history.push({
      player_id: userId,
      symbol: playerSymbol,
      cell: cellIdx,
      timestamp: new Date().toISOString(),
    });

    if (evaluation.isGameOver) {
      room.status = 'finished';
      if (evaluation.winner === 'draw') {
        room.winner_id = 'draw';
        if (db.users[room.player_one_id]) db.users[room.player_one_id].stats.ttt.draws++;
        if (room.player_two_id && db.users[room.player_two_id])
          db.users[room.player_two_id].stats.ttt.draws++;
      } else {
        const winnerId =
          evaluation.winner === room.player_one_symbol ? room.player_one_id : room.player_two_id;
        const loserId =
          evaluation.winner === room.player_one_symbol ? room.player_two_id : room.player_one_id;
        room.winner_id = winnerId;
        if (winnerId && db.users[winnerId]) db.users[winnerId].stats.ttt.wins++;
        if (loserId && db.users[loserId]) db.users[loserId].stats.ttt.losses++;
      }
    } else {
      room.current_turn = room.current_turn === 'X' ? 'O' : 'X';
    }
  } else if (room.game_type === 'chess') {
    const chess = new Chess(room.game_state.fen);
    try {
      const validMove = chess.move(move);
      if (!validMove) {
        res.status(400).json({ error: 'Illegal chess move.' });
        return;
      }

      const nowMs = Date.now();
      const prevWhiteTime =
        typeof room.game_state?.whiteTime === 'number' ? room.game_state.whiteTime : 600;
      const prevBlackTime =
        typeof room.game_state?.blackTime === 'number' ? room.game_state.blackTime : 600;
      const elapsedSec = room.game_state?.lastTurnAt
        ? Math.min(60, Math.max(0, Math.floor((nowMs - room.game_state.lastTurnAt) / 1000)))
        : 0;
      const nextWhiteTime =
        playerSymbol === 'w' ? Math.max(0, prevWhiteTime - elapsedSec) : prevWhiteTime;
      const nextBlackTime =
        playerSymbol === 'b' ? Math.max(0, prevBlackTime - elapsedSec) : prevBlackTime;

      const lastMoveInfo = {
        from: validMove.from,
        to: validMove.to,
        piece: validMove.piece,
        color: playerSymbol,
        flags: validMove.flags,
        captured: validMove.captured || null,
        promotion: validMove.promotion || null,
        san: validMove.san,
        timestamp: nowMs,
      };

      room.game_state = {
        ...getChessState(chess),
        whiteTime: nextWhiteTime,
        blackTime: nextBlackTime,
        lastTurnAt: nowMs,
        lastMove: lastMoveInfo,
      };
      room.state_version++;
      room.move_history.push({
        player_id: userId,
        color: playerSymbol,
        move: validMove.san,
        from: validMove.from,
        to: validMove.to,
        flags: validMove.flags,
        captured: validMove.captured || null,
        promotion: validMove.promotion || null,
        piece: validMove.piece,
        timestamp: new Date(nowMs).toISOString(),
      });

      if (room.game_state.isCheckmate) {
        room.status = 'finished';
        room.winner_id = userId;
        const loserId = isP1 ? room.player_two_id : room.player_one_id;
        if (db.users[userId]) {
          db.users[userId].stats.chess.wins++;
          db.users[userId].stats.chess.rating += 15;
        }
        if (loserId && db.users[loserId]) {
          db.users[loserId].stats.chess.losses++;
          db.users[loserId].stats.chess.rating = Math.max(
            800,
            db.users[loserId].stats.chess.rating - 15
          );
        }
      } else if (room.game_state.isDraw) {
        room.status = 'finished';
        room.winner_id = 'draw';
        if (db.users[room.player_one_id]) db.users[room.player_one_id].stats.chess.draws++;
        if (room.player_two_id && db.users[room.player_two_id])
          db.users[room.player_two_id].stats.chess.draws++;
      } else {
        room.current_turn = room.current_turn === 'w' ? 'b' : 'w';
      }
    } catch (e: any) {
      res.status(400).json({ error: 'Illegal move: ' + (e.message || 'invalid') });
      return;
    }
  }

  room.updated_at = new Date().toISOString();
  saveDb();

  // Broadcast authoritative move update to ALL authorized participants in the room
  broadcastToRoom(room, 'game_update', {
    roomId: room.id,
    room,
    players: getRoomPlayersPayload(room),
  });

  res.json({ room });
});

// In-Game Room Chat Message (Supports 2-Player and 3-Player rooms, strict auth, zero auto-replies)
app.post('/api/rooms/:roomId/chat', authMiddleware, (req: Request, res: Response): void => {
  const user = (req as any).user as UserRecord;
  const room = db.game_rooms[req.params.roomId];
  if (!room) {
    res.status(404).json({ error: 'Room not found.' });
    return;
  }

  if (!isAuthorizedInRoom(room, user.id)) {
    res.status(403).json({
      error: 'Access denied: Only authorized members of this room may send messages.',
    });
    return;
  }

  const { content } = req.body;
  if (!content || !content.trim()) {
    res.status(400).json({ error: 'Empty message' });
    return;
  }

  if (content.length > 1000) {
    res.status(400).json({ error: 'Message cannot exceed 1000 characters.' });
    return;
  }

  const chatMsg = {
    id: `rc-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    room_id: room.id,
    sender_id: user.id,
    sender_uid: user.public_uid,
    sender_name: user.username,
    content: content.trim(),
    created_at: new Date().toISOString(),
  };

  room.chat_messages.push(chatMsg);
  room.updated_at = new Date().toISOString();
  saveDb();

  // Deliver in real time to ALL authorized participants in this specific room (Player 1, Player 2, Player 3)
  broadcastToRoom(room, 'room_chat_message', {
    roomId: room.id,
    message: chatMsg,
  });

  res.status(201).json({ message: chatMsg });
});

// Resign / Offer Draw / Rematch Actions
app.post('/api/rooms/:roomId/action', authMiddleware, (req: Request, res: Response): void => {
  const userId = (req as any).user.id;
  const room = db.game_rooms[req.params.roomId];
  if (!room) {
    res.status(404).json({ error: 'Room not found.' });
    return;
  }

  if (!isAuthorizedInRoom(room, userId)) {
    res.status(403).json({ error: 'Access denied: You are not a participant in this room.' });
    return;
  }

  const { action } = req.body;
  const isP1 = room.player_one_id === userId;
  const opponentId = isP1 ? room.player_two_id : room.player_one_id;

  if (action === 'resign') {
    room.status = 'finished';
    room.winner_id = opponentId;
    if (opponentId && db.users[opponentId]) {
      if (room.game_type === 'chess') {
        db.users[opponentId].stats.chess.wins++;
        db.users[opponentId].stats.chess.rating += 15;
      } else {
        db.users[opponentId].stats.ttt.wins++;
      }
    }
    if (db.users[userId]) {
      if (room.game_type === 'chess') {
        db.users[userId].stats.chess.losses++;
        db.users[userId].stats.chess.rating = Math.max(
          800,
          db.users[userId].stats.chess.rating - 15
        );
      } else {
        db.users[userId].stats.ttt.losses++;
      }
    }
  } else if (action === 'draw') {
    room.status = 'finished';
    room.winner_id = 'draw';
    if (db.users[userId]) {
      if (room.game_type === 'chess') db.users[userId].stats.chess.draws++;
      else db.users[userId].stats.ttt.draws++;
    }
  } else if (action === 'rematch') {
    if (room.game_type === 'chess') {
      const chess = new Chess();
      room.game_state = {
        ...getChessState(chess),
        whiteTime: 600,
        blackTime: 600,
        lastTurnAt: Date.now(),
        lastMove: null,
      };
      room.current_turn = 'w';
    } else {
      room.game_state = {
        board: Array(9).fill(null),
        winningLine: null,
        isGameOver: false,
      };
      room.current_turn = 'X';
    }
    room.status = 'active';
    room.winner_id = null;
    room.state_version++;
    room.move_history = [];
  }

  room.updated_at = new Date().toISOString();
  saveDb();

  broadcastToRoom(room, 'game_update', {
    roomId: room.id,
    room,
    action,
    players: getRoomPlayersPayload(room),
  });

  res.json({ room });
});

// ----------------------------------------------------
// VITE DEV SERVER OR STATIC PROD SERVING
// ----------------------------------------------------
async function startServer() {
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        watch: {
          ignored: [
            '**/.data/**',
            '**/db.json',
            '**/.snapshots/**',
            '**/.playwright-mcp/**',
            '**/*.log',
          ],
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`ChessVerse 3D server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
