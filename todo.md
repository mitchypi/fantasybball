- Persist richer league metadata (keeper rules, injuries, lineup lock) in a proper database (SQLite + SQLModel or Postgres).
- Expand the simulation engine to support weekly head-to-head matchups, playoffs, waiver wire moves (no wire just free agents), and trade validation (player can force a trade between them and any other team). The first week starts when the first game is and a New week starts every Monday. You'll need to have standings somewhere on the dashboard as well as the matchup. Allow the player to view each. A matchup panel is comprised of the points for each team so far that week, along with the games played so far/games ahead, and also fantasy points/9cat contributions by each player on a team. Once you have weekly h2h matchups you can implement 9cat. 9cat matchups score based on how many categories won, so if I won my first matchup 6-3 then I would be in the standings as 6-3-0 WLD. Points matchups are winner take all, but for points leagues put points for and against in the standings too.

-Click on player to show their game log + fantasy points (if points league) as well as average points. Do it like how yahoo fantasy does it. 
Make it a pop-up card in the center of the screen designed like so.
   ---HEADER---
   Player name: Franz Wagner

   Position & team: SF, PF – Orlando Magic – #22

   Team name: Johnny Furphy

   Player headshot image (right side of header). Display image from NBA website (need a way to get links and map to player)
   ---Stats---
   Matchup	Fan Pts	Rank	FGM	FGA	FTM REST OF STATS FOLLOW
   Today	0.00	–	–	–	–
   Last 7 Days (avg)	43.30	31	9.0	17.0	4.0
   Last 14 Days (avg)	43.30	31	9.0	17.0	4.0
   Last 30 Days (avg)	43.30	31	9.0	17.0	4.0
   2025 season (avg)	43.30	31	9.0	17.0	4.0
   2024 season (avg)	40.89	34	9.0	19.4	4.5
   ---Game Log---
   | Date         | Opponent | Time / Result | Fan Pts | MIN | FGM | FGA | FTM | FTA | 3PTM | PTS | REST OF STATS FOLLOW
   | ------------ | -------- | ------------- | ------- | --- | --- | --- | --- | --- | ---- | --- |
   | Oct 27, 2025 | @PHI     | 4:00 PM       | 0.00    | –   | –   | –   | –   | –   | –    | –   |
   | Oct 25, 2025 | CHI      | 4:00 PM       | 0.00    | –   | –   | –   | –   | –   | –    | –   |
   | Oct 24, 2025 | ATL      | 4:00 PM       | 0.00    | –   | –   | –   | –   | –   | –    | –   |
   | Oct 22, 2025 | MIA      | W, 125–121    | 43.30   | 35  | 9   | 17  | 4   | 6   | 2    | 24  |

   ---ACTIONS---
   Add/Drop/Trade (depending on rostered status)

-Get player pictures for every player that played in this season. Need to map player id to image url from nba website. This will go in a the pop up player card. I will attach a file in root called rawplayers.json. Players will have a link to a picture of them somewhere in each json item. 

-remove all my game data from git

-delete scoring profiles

-light mode