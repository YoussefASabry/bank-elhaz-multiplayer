import { spawn } from 'child_process';
const server = spawn('node', ['server/index.js'], { stdio: 'inherit' });
const client = spawn('npx', ['vite', '--port', '5173'], { stdio: 'inherit' });
const kill = () => { server.kill(); client.kill(); process.exit(); };
process.on('SIGINT', kill);
process.on('SIGTERM', kill);
