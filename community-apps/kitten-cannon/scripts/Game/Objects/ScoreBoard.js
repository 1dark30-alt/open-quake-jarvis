import { Vector2D } from "../../Lib/Math/Vector2D.js";
import Button from "../UI/Button.js";

export default class ScoreBoard {
    constructor(canvas2D_context) {
        this.__ctx = canvas2D_context;
        this.score = "";
        this.highScore = "";
        this.globalHighScore = ""; // Add global high score property
        this.percentile = 0; // Add percentile property
        this.visible = false;
        this.buttons = {};
        this.onContinue = () => { }
        this.onMenu = () => { }
        this.__create_buttons();
        this.isNewRecord = false; // Add property to track if user set a new record
        this.leaderboard = [];    // [{rank, userid, score}] — filled by main.js
        this.playerTag = "";      // current player's tag, for row highlighting
    }

    __create_buttons() {

        let canvas_w_half = this.__ctx.canvas.width / 2;
        let canvas_h_half = this.__ctx.canvas.height / 2;

        // Bigger touch targets, spaced so the two hit boxes can't overlap
        // (they used to sit 30px apart with 44px-tall text: one tap hit both).
        let font_size = 52;
        let padding = new Vector2D(60, 6);
        this.__ctx.font = font_size + "px Nicotine";

        { // Continue button
            let text = "Continue";
            let font_width = this.__ctx.measureText(text).width;
            let position = new Vector2D(canvas_w_half - font_width / 2 - padding.x / 2, canvas_h_half + 35);
            this.buttons["continue"] = new Button(this.__ctx, text, position, font_size, "#ff680b", "Nicotine");
            this.buttons["continue"].padding = padding.copy();
            this.buttons["continue"].onClick = () => {
                this.onContinue();
            }
        }

        { // Exit to menu button
            let text = "Exit to menu";
            let font_width = this.__ctx.measureText(text).width;
            let position = new Vector2D(canvas_w_half - font_width / 2 - padding.x / 2, canvas_h_half + 95);
            this.buttons["exit_to_continue"] = new Button(this.__ctx, text, position, font_size, "#666", "Nicotine");
            this.buttons["exit_to_continue"].padding = padding.copy();
            this.buttons["exit_to_continue"].onClick = () => {
                this.onMenu();
            }
        }
    }

    draw() {
        if (!this.visible) return;
        let canvas_w_half = this.__ctx.canvas.width / 2;
        let canvas_h_half = this.__ctx.canvas.height / 2;

        { // Board  && Legs

            let boardW = 512;
            let boardH = 400; // Increased height to fit more text
            this.__ctx.lineWidth = 5;

            // Board
            this.__ctx.fillStyle = "#FFF";
            this.__ctx.strokeStyle = "#960";
            this.__ctx.fillRect(canvas_w_half - boardW / 2, canvas_h_half - boardH / 2 - 50, boardW, boardH);
            this.__ctx.strokeRect(canvas_w_half - boardW / 2, canvas_h_half - boardH / 2 - 50, boardW, boardH);

            // Legs
            this.__ctx.fillStyle = "#960";
            this.__ctx.strokeStyle = "#83520c";
            this.__ctx.fillRect(canvas_w_half - boardW / 2 + 76, canvas_h_half + boardH / 2 - 70, 15, 120);
            this.__ctx.strokeRect(canvas_w_half - boardW / 2 + 76, canvas_h_half + boardH / 2 - 70, 15, 120);
            this.__ctx.fillRect(canvas_w_half + boardW / 2 - 106, canvas_h_half + boardH / 2 - 70, 15, 120);
            this.__ctx.strokeRect(canvas_w_half + boardW / 2 - 106, canvas_h_half + boardH / 2 - 70, 15, 120);

            // Nuts
            this.__ctx.fillStyle = "#bbb";
            this.__ctx.beginPath();
            this.__ctx.arc(canvas_w_half - boardW / 2 + 76 + 15 / 2, canvas_h_half + boardH / 2 - 70 + 15 / 2, 15 / 2 - 2, 0, Math.PI * 2);
            this.__ctx.closePath();
            this.__ctx.fill();

            this.__ctx.beginPath();
            this.__ctx.arc(canvas_w_half + boardW / 2 - 106 + 15 / 2, canvas_h_half + boardH / 2 - 70 + 15 / 2, 15 / 2 - 2, 0, Math.PI * 2);
            this.__ctx.closePath();
            this.__ctx.fill();


        }

        this.__ctx.textBaseline = "top";
        { // Current Score - Big display
            this.__ctx.font = "100px Nicotine";

            if (this.score >= 1000) this.__ctx.fillStyle = "#600";
            else this.__ctx.fillStyle = "#060";


            let txt = this.score + " ft";
            let font_width = this.__ctx.measureText(txt).width;
            this.__ctx.fillText(txt, canvas_w_half - font_width / 2, canvas_h_half - 230);
        }
        
        // New Record message - display only if player set a new record
        if (parseInt(this.score) > parseInt(this.globalHighScore)) {
            this.__ctx.font = "52px Nicotine";
            this.__ctx.fillStyle = "#FF4500"; // Bright orange-red color
            
            let txt = "Congratulations! New PAX Record!";
            let font_width = this.__ctx.measureText(txt).width;
            this.__ctx.fillText(txt, canvas_w_half - font_width / 2, canvas_h_half - 130);
            
            // Add subtle animation - pulsing effect
            const pulseAmount = Math.sin(Date.now() / 200) * 0.1 + 0.9;
            this.__ctx.globalAlpha = pulseAmount;
            this.__ctx.fillText(txt, canvas_w_half - font_width / 2, canvas_h_half - 130);
            this.__ctx.globalAlpha = 1.0;
        } else {
            // Only show percentile if NOT a new record
            { // Percentile
                this.__ctx.font = "44px Nicotine";
                this.__ctx.fillStyle = "#0066cc";
                
                let txt = "Better than " + this.percentile + "% of players!";
                let font_width = this.__ctx.measureText(txt).width;
                this.__ctx.fillText(txt, canvas_w_half - font_width / 2, canvas_h_half - 130);
            }
        }

        { // Personal High Score
            let txt = "Your Best: " + this.highScore + " ft";
            this.__ctx.font = "44px Nicotine";
            if (this.highScore >= 1000) {
                this.__ctx.fillStyle = "#600";
            } else {
                this.__ctx.fillStyle = "#060";
            }
            let font_width = this.__ctx.measureText(txt).width;
            this.__ctx.fillText(txt, canvas_w_half - font_width / 2, canvas_h_half - 80);
        }
        
        { // Global High Score
            let txt;
            if (parseInt(this.score) > parseInt(this.globalHighScore)) {
                txt = "Old World Record: " + this.globalHighScore + " ft";
            } else {
                txt = "World Record: " + this.globalHighScore + " ft";
            }           
            this.__ctx.font = "44px Nicotine";
            this.__ctx.fillStyle = "#cc6600";
            
            let font_width = this.__ctx.measureText(txt).width;
            this.__ctx.fillText(txt, canvas_w_half - font_width / 2, canvas_h_half - 30);
        }
        
        { // Leaderboard side panel (skipped when there's no data or no room beside the board)
            let lb = this.leaderboard;
            if (Array.isArray(lb) && lb.length && this.__ctx.canvas.width >= 1600) {
                let panelW = 420;
                let panelH = 400;
                let panelX = canvas_w_half + 256 + 60;   // right of the 512-wide board
                let panelY = canvas_h_half - panelH / 2 - 50;

                this.__ctx.lineWidth = 5;
                this.__ctx.fillStyle = "#FFF";
                this.__ctx.strokeStyle = "#960";
                this.__ctx.fillRect(panelX, panelY, panelW, panelH);
                this.__ctx.strokeRect(panelX, panelY, panelW, panelH);

                // Legs, same style as the main board
                this.__ctx.fillStyle = "#960";
                this.__ctx.strokeStyle = "#83520c";
                this.__ctx.fillRect(panelX + 60, canvas_h_half + panelH / 2 - 70, 15, 120);
                this.__ctx.strokeRect(panelX + 60, canvas_h_half + panelH / 2 - 70, 15, 120);
                this.__ctx.fillRect(panelX + panelW - 75, canvas_h_half + panelH / 2 - 70, 15, 120);
                this.__ctx.strokeRect(panelX + panelW - 75, canvas_h_half + panelH / 2 - 70, 15, 120);

                this.__ctx.textBaseline = "top";
                this.__ctx.font = "40px Nicotine";
                this.__ctx.fillStyle = "#960";
                let title = "Top Kittens";
                let title_w = this.__ctx.measureText(title).width;
                this.__ctx.fillText(title, panelX + panelW / 2 - title_w / 2, panelY + 14);

                this.__ctx.font = "30px Nicotine";
                let rowY = panelY + 70;
                let me = String(this.playerTag || "").toUpperCase();
                for (let i = 0; i < lb.length && i < 8; i++) {
                    let entry = lb[i];
                    this.__ctx.fillStyle = (String(entry.userid).toUpperCase() === me) ? "#ff680b" : "#333";
                    this.__ctx.fillText(entry.rank + ". " + entry.userid, panelX + 24, rowY);
                    let score_txt = entry.score + " ft";
                    let score_w = this.__ctx.measureText(score_txt).width;
                    this.__ctx.fillText(score_txt, panelX + panelW - 24 - score_w, rowY);
                    rowY += 40;
                }
            }
        }

        for (let key in this.buttons) {
            this.buttons[key].draw();
        }

    }
    updateClickInput(cursor_position_vec) {

        if (!this.visible) return;
        if (!(cursor_position_vec instanceof Vector2D)) throw Error(" Cursor position should be a vector2D .");
        for (let button_key in this.buttons) {
            this.buttons[button_key].updateClickInput(cursor_position_vec);
        }
    }
}