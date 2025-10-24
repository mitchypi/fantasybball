- Persist richer league metadata (keeper rules, injuries, lineup lock) in a proper database (SQLite + SQLModel or Postgres).
- Expand the simulation engine to support weekly head-to-head matchups, playoffs, waiver wire moves (no wire just free agents), and trade validation (player can force a trade between them and any other team). The first week starts when the first game is and a New week starts every Monday. You'll need to have standings somewhere on the dashboard as well as the matchup. Allow the player to view each. A matchup panel is comprised of the points for each team so far that week, along with the games played so far/games ahead, and also fantasy points/9cat contributions by each player on a team. Once you have weekly h2h matchups you can implement 9cat. 9cat matchups score based on how many categories won, so if I won my first matchup 6-3 then I would be in the standings as 6-3-0 WLD. Points matchups are winner take all, but for points leagues put points for and against in the standings too. 
   -Add IL+ slots. If a player is a DNP then he can be on the IL+ slot and you can pick up players.

   -Add player's positions and restrict positions in the team which can be customized in league setup. Default 1 PG 1 SG 1 G 1 SF 1 PF 1 F 1 C 3 UTIL 3 BENCH 3 IL+

-Make the game log show all games. Make it scrollable. Place the Drop and Trade buttons to under the Game logs but they will always be visible because the player profile is no longer scrollable, just the game log section

-Have a farsight button 

-Change Team Name on the player profile to just say Team. Example: Team name: Team 1 -> Team: Team 1

-Change the time controls because it is confusing with the "current date" being one day after the games shown on the scoreboard. For example if it is 10/29, to see the results of the games of 10/29 you have to simulate the next day and go to 10/30. Align the scoreboard date and current date. The simulate next day button will turn into "Play today's games" and then after the games have been played the button turns into "Go to next day". Make sure the dates for everything match up with the rest of the systems. The game starts on 10/22/2024 and that is the date for both the current date and the scoreboard date. However when you simulate next day, the scoreboard stays at 10/22 while the current day goes to 10/23. With this new system. The game starts before the games on 10/22, and then the player clicks play todays games, and then the nba scoreboard and fantasy stats for the games played that day update. After that, in the fantasy team roster section, the fantasy points displayed will show the games for the current day rather than last day

-light mode

--add fouls to the nba scoreboard

-Click on player to show their game log + fantasy points (if points league) as well as average points. Do it like how yahoo fantasy does it. 
Make it a pop-up card in the center of the screen designed like so.
   ---HEADER---
   Player headshot image (left side of header). Display image from NBA website (check rawplayers.json, it has json objects with player names and nba picture urls.)
      right side of header:
      Player name: Franz Wagner

      Position & team: SF, PF – Orlando Magic – #22

      Team : Johnny Furphy

   
   ---Stats---
   Matchup	Fan Pts	MIN  PTS 	REB 	AST 	STL 	BLK 	FG 	3PT 	FT 	TO	PF	
   Today	0.00	–	–	–	–
   Last 7 Days (avg)	43.30	31	9.0	17.0	4.0
   Last 14 Days (avg)	43.30	31	9.0	17.0	4.0
   Last 30 Days (avg)	43.30	31	9.0	17.0	4.0
   2025 season (avg)	43.30	31	9.0	17.0	4.0
   2024 season (avg)	40.89	34	9.0	19.4	4.5
   ---Game Log--- (this will be scrollable once there are enough games), and dont show future games.
   | Date         | Opponent | Time / Result | Fan Pts	MIN  PTS 	REB 	AST 	STL 	BLK 	FG 	3PT 	FT 	TO	PF	
   | ------------ | -------- | ------------- | ------- | --- | --- | --- | --- | --- | ---- | --- |
   | Oct 27, 2025 | @PHI     | 4:00 PM       | 0.00    | –   | –   | –   | –   | –   | –    | –   |
   | Oct 25, 2025 | CHI      | 4:00 PM       | 0.00    | –   | –   | –   | –   | –   | –    | –   |
   | Oct 24, 2025 | ATL      | 4:00 PM       | 0.00    | –   | –   | –   | –   | –   | –    | –   |
   | Oct 22, 2025 | MIA      | W, 125–121    | 43.30   | 35  | 9   | 17  | 4   | 6   | 2    | 24  |

   STATS IN THIS ORDER: MIN 	PTS 	REB 	AST 	STL 	BLK 	FG 	3PT 	FT 	TO PF

   ---ACTIONS--- (bottom left corner, do not let the game log cover this)
   Add/Drop/Trade (depending on rostered status)
NOTES: -- **Box scores & players:** Selecting a game fetches `GET /games/{game_id}/boxscore`. Clicking any player name (box score or team card) opens the modal fed by `GET /players/{id}/profile`, showing headshots plus per-split fantasy averages, the expanded MIN→TOV stat grid, and season labels (e.g. `2024-2025 season (avg)`). All games appear in the scrollable log (with Drop/Trade buttons anchored below), DNPs (0 minutes) are omitted from averages, and the modal only counts games through the league's latest simulated date.
--player_profile.py might be able to be used for this
--rawplayers.json has json object with player names and urls of that players pictures that you can use to create a mapping of players and their pictures


--add pycache to gitignore

--Remove vertical scrolling for the entire player card and only have it for the game log section. Scroll the games but not the col labels. Also make the player image the same height as the text in the header. Remove season rank from the card.