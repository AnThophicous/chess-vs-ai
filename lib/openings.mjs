// Opening book (names in English). Detection compares POSITIONS, not move order,
// so transpositions are recognized too.
import { Chess } from 'chess.js';

const LINES = [
  ['King\'s Pawn Opening', 'e4'],
  ['Queen\'s Pawn Opening', 'd4'],
  ['English Opening', 'c4'],
  ['Réti Opening', 'Nf3'],
  ['Bird\'s Opening', 'f4'],
  ['Larsen\'s Opening', 'b3'],
  ['Polish Opening (Sokolsky)', 'b4'],
  ['Van Geet Opening', 'Nc3'],
  ['Grob Attack', 'g4'],
  ['King\'s Indian Attack (fianchetto)', 'g3'],
  ['Ware Opening', 'a4'],
  ['Desprez Opening', 'h4'],
  ['Open Game', 'e4 e5'],
  ['Sicilian Defense', 'e4 c5'],
  ['Open Sicilian', 'e4 c5 Nf3 d6 d4'],
  ['Open Sicilian', 'e4 c5 Nf3 Nc6 d4'],
  ['Open Sicilian', 'e4 c5 Nf3 e6 d4'],
  ['Sicilian Najdorf', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6'],
  ['Sicilian Dragon', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6'],
  ['Sicilian Classical', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 Nc6'],
  ['Sicilian Scheveningen', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 e6'],
  ['Sicilian Sveshnikov', 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5'],
  ['Alapin Sicilian', 'e4 c5 c3'],
  ['Closed Sicilian', 'e4 c5 Nc3'],
  ['Smith-Morra Gambit', 'e4 c5 d4 cxd4 c3'],
  ['Rossolimo Sicilian', 'e4 c5 Nf3 Nc6 Bb5'],
  ['Moscow Sicilian', 'e4 c5 Nf3 d6 Bb5+'],
  ['French Defense', 'e4 e6'],
  ['French Advance', 'e4 e6 d4 d5 e5'],
  ['French Exchange', 'e4 e6 d4 d5 exd5'],
  ['French Tarrasch', 'e4 e6 d4 d5 Nd2'],
  ['French Winawer', 'e4 e6 d4 d5 Nc3 Bb4'],
  ['French Classical', 'e4 e6 d4 d5 Nc3 Nf6'],
  ['Caro-Kann Defense', 'e4 c6'],
  ['Caro-Kann Advance', 'e4 c6 d4 d5 e5'],
  ['Caro-Kann Classical', 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5'],
  ['Caro-Kann Exchange', 'e4 c6 d4 d5 exd5 cxd5'],
  ['Caro-Kann Panov-Botvinnik', 'e4 c6 d4 d5 exd5 cxd5 c4'],
  ['Caro-Kann Two Knights', 'e4 c6 Nc3 d5 Nf3'],
  ['Pirc Defense', 'e4 d6 d4 Nf6 Nc3 g6'],
  ['Modern Defense', 'e4 g6'],
  ['Scandinavian Defense', 'e4 d5'],
  ['Scandinavian: main line', 'e4 d5 exd5 Qxd5'],
  ['Modern Scandinavian', 'e4 d5 exd5 Nf6'],
  ['Alekhine Defense', 'e4 Nf6'],
  ['Nimzowitsch Defense', 'e4 Nc6'],
  ['Owen Defense', 'e4 b6'],
  ['St. George Defense', 'e4 a6'],
  ['Ponziani Opening', 'e4 e5 Nf3 Nc6 c3'],
  ['Philidor Defense', 'e4 e5 Nf3 d6'],
  ['Petrov Defense', 'e4 e5 Nf3 Nf6'],
  ['Latvian Gambit', 'e4 e5 Nf3 f5'],
  ['Damiano Defense (don\'t do this)', 'e4 e5 Nf3 f6'],
  ['Elephant Gambit', 'e4 e5 Nf3 d5'],
  ['Four Knights Game', 'e4 e5 Nf3 Nc6 Nc3 Nf6'],
  ['Three Knights Game', 'e4 e5 Nf3 Nc6 Nc3'],
  ['Scotch Game', 'e4 e5 Nf3 Nc6 d4'],
  ['Scotch: main line', 'e4 e5 Nf3 Nc6 d4 exd4 Nxd4'],
  ['Scotch Gambit', 'e4 e5 Nf3 Nc6 d4 exd4 Bc4'],
  ['Italian Game', 'e4 e5 Nf3 Nc6 Bc4'],
  ['Giuoco Piano', 'e4 e5 Nf3 Nc6 Bc4 Bc5'],
  ['Giuoco Pianissimo', 'e4 e5 Nf3 Nc6 Bc4 Bc5 d3'],
  ['Italian: main line', 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3'],
  ['Evans Gambit', 'e4 e5 Nf3 Nc6 Bc4 Bc5 b4'],
  ['Two Knights Defense', 'e4 e5 Nf3 Nc6 Bc4 Nf6'],
  ['Two Knights: Knight Attack', 'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5'],
  ['Fried Liver Attack', 'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Nxd5 Nxf7'],
  ['Hungarian Defense', 'e4 e5 Nf3 Nc6 Bc4 Be7'],
  ['Ruy López (Spanish Game)', 'e4 e5 Nf3 Nc6 Bb5'],
  ['Spanish: Morphy Defense', 'e4 e5 Nf3 Nc6 Bb5 a6'],
  ['Closed Spanish', 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7'],
  ['Berlin Defense', 'e4 e5 Nf3 Nc6 Bb5 Nf6'],
  ['Spanish Exchange', 'e4 e5 Nf3 Nc6 Bb5 a6 Bxc6'],
  ['King\'s Gambit', 'e4 e5 f4'],
  ['King\'s Gambit Accepted', 'e4 e5 f4 exf4'],
  ['King\'s Gambit Declined', 'e4 e5 f4 Bc5'],
  ['Vienna Game', 'e4 e5 Nc3'],
  ['Bishop\'s Opening', 'e4 e5 Bc4'],
  ['Center Game', 'e4 e5 d4 exd4'],
  ['Danish Gambit', 'e4 e5 d4 exd4 c3'],
  ['Parham Attack (the shepherd\'s mate)', 'e4 e5 Qh5'],
  ['Napoleon Attack', 'e4 e5 Qf3'],
  ['Queen\'s Gambit', 'd4 d5 c4'],
  ['Queen\'s Gambit Declined', 'd4 d5 c4 e6'],
  ['Queen\'s Gambit Accepted', 'd4 d5 c4 dxc4'],
  ['Slav Defense', 'd4 d5 c4 c6'],
  ['Semi-Slav Defense', 'd4 d5 c4 c6 Nf3 Nf6 Nc3 e6'],
  ['Albin Countergambit', 'd4 d5 c4 e5'],
  ['Chigorin Defense', 'd4 d5 c4 Nc6'],
  ['Tarrasch Defense', 'd4 d5 c4 e6 Nc3 c5'],
  ['London System', 'd4 d5 Bf4'],
  ['London System', 'd4 Nf6 Bf4'],
  ['London System', 'd4 d5 Nf3 Nf6 Bf4'],
  ['Jobava London System', 'd4 d5 Nc3 Nf6 Bf4'],
  ['Colle System', 'd4 d5 Nf3 Nf6 e3'],
  ['Torre Attack', 'd4 Nf6 Nf3 e6 Bg5'],
  ['Torre Attack', 'd4 d5 Nf3 Nf6 Bg5'],
  ['Trompowsky Attack', 'd4 Nf6 Bg5'],
  ['Veresov Attack', 'd4 d5 Nc3 Nf6 Bg5'],
  ['Blackmar-Diemer Gambit', 'd4 d5 e4'],
  ['Indian Defense', 'd4 Nf6'],
  ['King\'s Indian Defense', 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6'],
  ['Grünfeld Defense', 'd4 Nf6 c4 g6 Nc3 d5'],
  ['Nimzo-Indian Defense', 'd4 Nf6 c4 e6 Nc3 Bb4'],
  ['Queen\'s Indian Defense', 'd4 Nf6 c4 e6 Nf3 b6'],
  ['Bogo-Indian Defense', 'd4 Nf6 c4 e6 Nf3 Bb4+'],
  ['Catalan Opening', 'd4 Nf6 c4 e6 g3'],
  ['Benoni Defense', 'd4 Nf6 c4 c5 d5'],
  ['Benko Gambit', 'd4 Nf6 c4 c5 d5 b5'],
  ['Budapest Gambit', 'd4 Nf6 c4 e5'],
  ['Dutch Defense', 'd4 f5'],
  ['Staunton Gambit', 'd4 f5 e4'],
  ['Modern Defense', 'd4 g6'],
  ['Symmetrical English', 'c4 c5'],
  ['English: Reversed Sicilian', 'c4 e5'],
  ['English: Anglo-Indian', 'c4 Nf6'],
  ['Réti: Gambit', 'Nf3 d5 c4'],
  ['Réti: King\'s Indian Attack', 'Nf3 d5 g3'],
  ['King\'s Indian Attack (setup)', 'Nf3 Nf6 g3 g6'],
];

const keyOf = (chess) => chess.fen().split(' ').slice(0, 2).join(' ');

const NAMES = new Map();   // final position of each line -> name
const BOOK = new Set();    // every position that appears in some line
for (const [name, line] of LINES) {
  const c = new Chess();
  for (const san of line.split(' ')) {
    try { c.move(san); } catch { throw new Error(`Invalid opening line: ${name} (${line})`); }
    BOOK.add(keyOf(c));
  }
  if (!NAMES.has(keyOf(c))) NAMES.set(keyOf(c), name);
}

/** Name of the most specific opening reached. fens = positions after each move. */
export function detectOpening(fens) {
  for (let i = fens.length - 1; i >= 0; i--) {
    const key = fens[i].split(' ').slice(0, 2).join(' ');
    const name = NAMES.get(key);
    if (name) return { name, ply: i + 1 };
  }
  return null;
}

/** Is the position (FEN) in the book? */
export function isBook(fen) {
  return BOOK.has(fen.split(' ').slice(0, 2).join(' '));
}
