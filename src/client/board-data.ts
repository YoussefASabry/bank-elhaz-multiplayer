/**
 * The raw board file, typed.
 *
 * Only the LOBBY PREVIEW reads this. Once a game is running the board arrives
 * inside `ClientState`, and rendering from the local file instead would let a
 * client show a board the server is not playing on.
 */

import boardJson from '../../data/board.json' with { type: 'json' };
import type { RawBoard, RawSquare } from '../shared/raw.js';

const board = boardJson as unknown as RawBoard;

export const rawSquares: readonly RawSquare[] = board.board_positions;
export const rawMeta = board.game_meta;
