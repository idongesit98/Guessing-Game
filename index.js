const express = require('express')
const {createServer} = require('node:http')
const {join} = require('node:path')
const {Server} = require('socket.io')

const app = express()
const server = createServer(app)

//Bind http server on socket.io
const io = new Server(server);

// app.get('/', (req,res) => {
//     res.sendFile(join(__dirname, 'index.html'));
// });
app.use(express.static('public'))

let sessions = {};

class GameSession{
    constructor(sessionId,masterId){
        this.sessionId = sessionId;
        this.masterId = masterId;
        this.players = {};
        this.answer = '';
        this.gameInProgress = false;
        this.timer = null;
    }
}

function updateSession(session){
    const data = {
        players:Object.values(session.players).map(p => ({username: p.username, score:p.score})),
        playerCount:Object.keys(session.players).length
    };
    io.to(session.sessionId).emit('sessionUpdate',data);
}

io.on('connection', (socket) => {
    console.log('New connection:  ' + socket.id);

    socket.on('createSession', (data) => {
        const sessionId = 'session-' + socket.id;
        const newSession = new GameSession(sessionId,socket.id);
        //Add game master as a player
        newSession.players[socket.id] = {username:data.username || 'Master', score:0, attempts:3};
        sessions[sessionId] = newSession;
        socket.join(sessionId);
        socket.emit('sessionCreated',{sessionId});
        updateSession(newSession);
    });

    //Allow others users to join a session
    socket.on('joinSession', (data) => {
        const sessionId = data.sessionId.trim();
        console.log('Join request for session:', sessionId);
        const session = sessions[sessionId];
        if (!session) {
            socket.emit('errorMsg', {msg: 'Session does not exist'});
            return;
        }
        //prevent joining if game is in progress
        if (session.gameInProgress) {
            socket.emit('errorMsg',{msg:'Game already in progress'})
            return;
        }
        session.players[socket.id] = {username:data.username || 'Player', score:0, attempts:3};
        socket.join(sessionId)
        updateSession(session)
    });

    //Game master sets the question and answer
    socket.on('setQuestion', (data) => {
        //Find the session where this socket is the master
        let session = Object.values(sessions).find(s => s.masterId === socket.id);
        if(!session){
            socket.emit('errorMsg', {msg: 'You are not a game master'});
            return
        }
        session.question = data.question;
        session.answer = data.answer;
        socket.emit('message',{msg:'Question and answer set. Ready to start the game.'});
    });

    //Start the game session(Only allowed by game master)
    socket.on('startGame',() =>{
        let session = Object.values(sessions).find(s => s.masterId === socket.id);
        if (!session) {
            socket.emit('errorMsg',{msg:'You are not a game master'});
            return;
        }
        //Require at least 3 players(including game master)
        if (Object.keys(session.players).length < 3) {
            socket.emit('errorMsg', {msg:'At least 3 players (including game master) required to start game'});
            return;
        }
        session.gameInProgress = true;

        //Broadcast the question to all players
        io.to(session.sessionId).emit('gameStarted', {question:session.question});
        
        //Reset attempts for the next round.
        session.timer = setTimeout(() => {
            session.gameInProgress = false;
            io.to(session.sessionId).emit('gameEnded',{msg:'Time expired', answer:session.answer});
            //Reset attempts for the next round.
            Object.keys(session.players).forEach(pid => session.players[pid].attempts = 3);
        },60000);
    });

    //Handle guesses from players
    socket.on('guess',(data) => {
        //Find the session for this socket.
        let session = Object.values(sessions).find(s => s.players[socket.id]);
        if (!session || !session.gameInProgress) {
            socket.emit('errorMsg', {msg: 'No active game session for you'});
            return;
        }
        let player = session.players[socket.id];
        if (player.attempts <= 0) {
            socket.emit('message',{msg: 'No active game session for you'});
            return;
        }
        player.attempts -= 1;
        //check if the guess is correct
        if(data.guess.toLowerCase() === session.answer.toLowerCase()){
            clearTimeout(session.timer);
            session.gameInProgress = false;
            player.score += 10;
            io.to(session.sessionId).emit('gameEnded',{
                msg:`${player.username} has won! The answer was: ${session.answer}`,
                winner:player.username
            });
            updateSession(session);
            //Reset attempts for next round
            Object.keys(session.players).forEach(pid => session.players[pid].attempts = 3);
        }else{
            socket.emit('message',{msg: `Wrong guess. Attempts left: ${player.attempts}`})
        }
    });

    //Handle general chat messages
    socket.on('chatMessage', (data) =>{
        let session = Object.values(sessions).find(s => s.players[socket.id]);
        if(!session){
            socket.emit('errorMsg',{msg:'You are not in a session'});
            return;
        }
        io.to(session.sessionId).emit('chatMessage',{
            username:session.players[socket.id].username,
            msg:data.msg
        });
    });

    //clean up when a socket disconnects
    socket.on('disconnect', () => {
        console.log('Disconnected: ' + socket.id);
        for(let sessionId in sessions){
            let session = sessions[sessionId];
            if (session.players[socket.id]) {
                delete session.players[socket.id];
                //If the game master disconnects, reassign a new one if possible.
                 if(session.masterId === socket.id){
                    const remaining = Object.keys(session.players);
                    if (remaining.lenght > 0) {
                        session.masterId = remaining[0];
                        io.to(session.sessionId).emit('message',{msg: `${session.players[session.masterId].username} is the new game master.`});
                    }
                 }
                 updateSession(session);
                 //Delete session if no players remain
                 if (Object.keys(session.players).length === 0) {
                    delete sessions[sessionId];
                 }
                 break;
            }
        }
    })
})

const PORT = 4040;
const HOST = '127.0.0.1';

server.listen(PORT,HOST,() => {
    console.log(`Server running at http://localhost:${PORT}`)
}) 
