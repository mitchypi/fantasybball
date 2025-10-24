- Persist richer league metadata (keeper rules, injuries, lineup lock) in a proper database (SQLite + SQLModel or Postgres).

   -Add IL+ slots. If a player is a DNP then he can be on the IL+ slot and you can pick up players.

   -Add player's positions and restrict positions in the team which can be customized in league setup. Default 1 PG 1 SG 1 G 1 SF 1 PF 1 F 1 C 3 UTIL 3 BENCH 3 IL+

-Make the game log show all games. Make it scrollable. Place the Drop and Trade buttons to under the Game logs but they will always be visible because the player profile is no longer scrollable, just the game log section

-Have a farsight button 




-light mode

--add fouls to the nba scoreboard

--add pycache to gitignore


-The box section height for NBA scores and Fantasy leaderboard are equal and the value is going the be the height of the taller box. Make the heights independent based on the size of the contents within. Attached is an image of how it looks right now.

-add delete all leagues option.

- Expand the simulation engine to support weekly head-to-head matchups, playoffs, waiver wire moves (no wire just free agents), and trade validation (player can force a trade between them and any other team). The first week starts when the first game is and a New week starts every Monday. You'll need to have standings somewhere on the dashboard as well as the matchup. Allow the player to view each. A matchup panel is comprised of the points for each team so far that week, along with the games played so far/games ahead, and also fantasy points/9cat contributions by each player on a team. Once you have weekly h2h matchups you can implement 9cat. 9cat matchups score based on how many categories won, so if I won my first matchup 6-3 then I would be in the standings as 6-3-0 WLD. Points matchups are winner take all, but for points leagues put points for and against in the standings too. 

- Expand the simulation to support weekly head-to-head matchups and playoffs. The user can choose when playoffs starts and how many teams make it to playoffs. The fantasy league section will show all the matchups

- Make fantasy league teams act the same as nba scores



-make player link buttons act like the nba score open on click thing

-make player names all on one line for the player buttons. you might have to expand the width of the button and player column for a scorecard.