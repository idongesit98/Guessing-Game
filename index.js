const express = require('express')
const {createServer} = require('node:http')
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
        this.sessionId = sessionId
        this.masterId = masterId
        this.players = {}
        this.question =''
        this.answer = ''
        this.gameInProgress = false
        this.timer = null
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

    socket.on('createSession', ({username}) => {
        if (!username?.trim()) {
            socket.emit('errorMsg',{msg:'Username is required to create a session'});
            return
        }

        const sessionId = 'session-' + socket.id;
        const session = new GameSession(sessionId, socket.id);

        //Add game master as a player
        session.players[socket.id] = {username:username.trim(), score:0, attempts:3};
        sessions[sessionId] = session;

        socket.join(sessionId);
        socket.emit('sessionCreated',{sessionId});
        updateSession(session);
    });

    //Allow others users to join a session
    socket.on('joinSession', ({sessionId,username}) => {
        if (!username?.trim()) {
            socket.emit('errorMsg', {msg:'Username is required to join a session'});
            return;
        }
        const session = sessions[sessionId.trim()];
        if (!session) {
            socket.emit('errorMsg', {msg:'Session does not exist'})
            return;
        }

        if (session.gameInProgress) {
            socket.emit('errorMsg',{msg:'Game already in progress'})
            return;
        }

        session.players[socket.id] = {username:username.trim(),score:0,attempts:3};
        socket.join(sessionId);
        updateSession(session);
    });

    //Game master sets the question and answer
    socket.on('setQuestion', ({question,answer}) => {
        //Find the session where this socket is the master
        const session = Object.values(sessions).find(s => s.masterId === socket.id);
        if(!session){
            socket.emit('errorMsg', {msg: 'You are not a game master'});
            return
        }
        session.question = question;
        session.answer = answer;
        socket.emit('message',{msg:'Question and answer set. Ready to start the game.'});
    });

    //Start the game session(Only allowed by game master)
    socket.on('startGame',() =>{
        const session = Object.values(sessions).find(s => s.masterId === socket.id);
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

        Object.values(session.players).forEach(p => p.attempts = 3);

        //Broadcast the question to all players
        io.to(session.sessionId).emit('gameStarted', {question:session.question});
        
        //Reset attempts for the next round.
        session.timer = setTimeout(() => {
            session.gameInProgress = false;
            io.to(session.sessionId).emit('gameEnded',{msg:'Time expired', answer:session.answer});
            //Reset attempts for the next round.
            updateSession(session);
        },60000);
    });

    //Handle guesses from players
    socket.on('guess',({guess}) => {
        //Find the session for this socket.
        const session = Object.values(sessions).find(s => s.players[socket.id]);
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
        if(guess.trim().toLowerCase() === session.answer.toLowerCase()){
            clearTimeout(session.timer);
            session.gameInProgress = false;
            player.score += 10;
            io.to(session.sessionId).emit('gameEnded',{
                msg:`${player.username} has won!`,
                winner:player.username,
                answer:session.answer
            });
            Object.values(session.players).forEach(p => p.attempts = 3);
            updateSession(session);
         }else{
            socket.emit('message',{msg: `Wrong guess. Attempts left: ${player.attempts}`})
            updateSession(session);
        }
    });

    //Handle general chat messages
    socket.on('chatMessage', ({msg}) =>{//start here
        const session = Object.values(sessions).find(s => s.players[socket.id]);
        if(!session){
            socket.emit('errorMsg',{msg:'You are not in a session'});
            return;
        }
        io.to(session.sessionId).emit('chatMessage',{
            username:session.players[socket.id].username,
            msg
        });
    });

    //clean up when a socket disconnects
    socket.on('disconnect', () => {
        console.log('Disconnected: ' + socket.id);
        for(let sessionId in sessions){
            const session = sessions[sessionId];

            if (session.players[socket.id]) {
                const isMaster = session.masterId === socket.id
                const username = session.players[socket.id].username;
                delete session.players[socket.id];

                //If the game master disconnects, reassign a new one if possible.
                 if(isMaster){
                    const remaining = Object.keys(session.players);
                    if (remaining.length > 0) {
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
