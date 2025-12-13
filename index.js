const express = require('express');
const cors = require('cors');
require('dotenv').config();
const port = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());



app.get('/', (req, res) => {
  res.send(`Hello from asg_11_server`);
});

app.listen(port, ()=>{
    console.log(`server is running on ${port}`)
})