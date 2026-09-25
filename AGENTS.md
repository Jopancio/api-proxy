# Project workflow

- After making and validating changes, restart both `server.js` and `telegram-bot.js`, as requested by the user. Verify the API health endpoint and the bot startup log. Avoid duplicate bot polling processes.
- Run services from this project directory. Launch background processes with hidden windows on Windows.
- Preserve production data in `data/`. Never delete that directory as test cleanup. Use isolated temporary directories for tests and remove only the test artifacts created by that test.
