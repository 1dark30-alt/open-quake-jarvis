import { Vector2D } from "../../Lib/Math/Vector2D.js";

export default class DistanceDisplay {
    constructor(renderer, pixels_per_feet, font_name = null) {
        this.renderer = renderer;
        this.__ctx = renderer.ctx;
        this.pixels_per_feet = pixels_per_feet;
        this.position = new Vector2D(20, 80); // Position in top left corner
        this.distance_px = 0;
        this.font_name = font_name;
    }

    update(distance_px) {
        this.distance_px = distance_px;
    }

    draw() {
        let distance_feet = (this.distance_px / this.pixels_per_feet).toFixed(0);
        
        this.__ctx.save();
        this.__ctx.textBaseline = "top";
        
        // Background - properly begin and close the path
        this.__ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
        this.__ctx.beginPath(); // Begin the path explicitly
        this.__ctx.roundRect(this.position.x, this.position.y, 200, 60, 5);
        this.__ctx.closePath(); // Close the path explicitly
        this.__ctx.fill();
        
        // Distance text
        this.__ctx.fillStyle = "#FFFFFF";
        this.__ctx.font = "24px " + (this.font_name || "Arial");
        this.__ctx.fillText("DISTANCE", this.position.x + 15, this.position.y + 5);

        // Distance value
        this.__ctx.font = "30px " + (this.font_name || "Arial");
        this.__ctx.fillStyle = "#FFA500"; // Orange color for distance
        this.__ctx.fillText(distance_feet + " ft", this.position.x + 15, this.position.y + 30);
        
        this.__ctx.restore();
    }
}