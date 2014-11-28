/**
 * @fileoverview Implements the PCjs CPU component.
 * @author <a href="mailto:Jeff@pcjs.org">Jeff Parsons</a>
 * @version 1.0
 * Created 2012-Sep-04
 *
 * Copyright © 2012-2014 Jeff Parsons <Jeff@pcjs.org>
 *
 * This file is part of PCjs, which is part of the JavaScript Machines Project (aka JSMachines)
 * at <http://jsmachines.net/> and <http://pcjs.org/>.
 *
 * PCjs is free software: you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version.
 *
 * PCjs is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
 * even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with PCjs.  If not,
 * see <http://www.gnu.org/licenses/gpl.html>.
 *
 * You are required to include the above copyright notice in every source code file of every
 * copy or modified version of this work, and to display that copyright notice on every screen
 * that loads or runs any version of this software (see Computer.sCopyright).
 *
 * Some PCjs files also attempt to load external resource files, such as character-image files,
 * ROM files, and disk image files. Those external resource files are not considered part of the
 * PCjs program for purposes of the GNU General Public License, and the author does not claim
 * any copyright as to their contents.
 */

"use strict";

if (typeof module !== 'undefined') {
    var str         = require("../../shared/lib/strlib");
    var usr         = require("../../shared/lib/usrlib");
    var Component   = require("../../shared/lib/component");
    var Debugger    = require("./debugger");
}

/**
 * CPU(parmsCPU, nCyclesDefault)
 *
 * The CPU class supports the following (parmsCPU) properties:
 *
 *      cycles: the machine's base cycles per second; the X86CPU constructor will
 *      provide us with a default (based on the CPU model) to use as a fallback
 *
 *      multiplier: base cycle multiplier; default is 1
 *
 *      autoStart: true to automatically start, false to not, or null (default)
 *      to make the autoStart decision based on whether or not a Debugger is
 *      installed (if there's no Debugger AND no "Run" button, then auto-start,
 *      otherwise don't)
 *
 *      csStart: the number of cycles that runCPU() must wait before generating
 *      checksum records; -1 if disabled. checksum records are a diagnostic aid
 *      used to help compare one CPU run to another.
 *
 *      csInterval: the number of cycles that runCPU() must execute before
 *      generating a checksum record; -1 if disabled.
 *
 *      csStop: the number of cycles to stop generating checksum records.
 *
 * This component is primarily responsible for interfacing the CPU with the outside
 * world (eg, Panel and Debugger components), and managing overall CPU operation.
 *
 * It is extended by the X86CPU component, where all the x86-specific logic resides.
 *
 * @constructor
 * @extends Component
 * @param {Object} parmsCPU
 * @param {number} nCyclesDefault
 */
function CPU(parmsCPU, nCyclesDefault)
{
    Component.call(this, "CPU", parmsCPU, CPU);

    var nCycles = parmsCPU['cycles'] || nCyclesDefault;

    var nMultiplier = parmsCPU['multiplier'] || 1;

    this.aCounts = {};
    this.aCounts.nCyclesPerSecond = nCycles;

    /*
     * nCyclesMultiplier replaces the old "speed" variable (0, 1, 2) and eliminates the need for
     * the constants (SPEED_SLOW, SPEED_FAST and SPEED_MAX).  The UI simply doubles the multiplier
     * until we've exceeded the host's speed limit and then starts the multiplier over at 1.
     */
    this.aCounts.nCyclesMultiplier = nMultiplier;
    this.aCounts.mhzDefault = Math.round(this.aCounts.nCyclesPerSecond / 10000) / 100;
    /*
     * TODO: Take care of this with an initial setSpeed() call instead?
     */
    this.aCounts.mhzTarget = this.aCounts.mhzDefault * this.aCounts.nCyclesMultiplier;

    this.bitField.fPowered = false;
    this.bitField.fRunning = false;
    this.bitField.fStarting = false;
    this.bitField.fAutoStart = parmsCPU['autoStart'];

    /*
     * TODO: Add some UI for fDisplayLiveRegs (either an XML property, or a UI checkbox, or both)
     */
    this.bitField.fDisplayLiveRegs = false;

    /*
     * Provide a power-saving URL-based way of overriding the 'autostart' setting;
     * if an "autostart" parameter is specified on the URL, anything other than "true"
     * or "false" is treated as the null setting (see above for details).
     */
    var sAutoStart = Component.parmsURL['autostart'];
    if (sAutoStart !== undefined) {
        this.bitField.fAutoStart = (sAutoStart == "true"? true : (sAutoStart  == "false"? false : null));
    }

    /*
     * Get checksum parameters, if any. runCPU() behavior is not affected until fChecksum
     * is true, which won't happen until resetChecksum() is called with nCyclesChecksumInterval
     * ("csInterval") set to a positive value.
     *
     * As above, any of these parameters can also be set with the Debugger's execution options
     * command ("x"); for example, "x cs int 5000" will set nCyclesChecksumInterval to 5000
     * and call resetChecksum().
     */
    this.bitField.fChecksum = false;
    this.aCounts.nChecksum = this.aCounts.nCyclesChecksumNext = 0;
    this.aCounts.nCyclesChecksumStart = parmsCPU["csStart"];
    this.aCounts.nCyclesChecksumInterval = parmsCPU["csInterval"];
    this.aCounts.nCyclesChecksumStop = parmsCPU["csStop"];

    var cpu = this;
    this.onRunTimeout = function() { cpu.runCPU(); };

    this.setReady();
}

Component.subclass(Component, CPU);

/*
 * Constants that control the frequency at which various updates should occur.
 *
 * These values do NOT control the simulation directly.  Instead, they are used by
 * calcCycles(), which uses the nCyclesPerSecond passed to the constructor as a starting
 * point and computes the following variables:
 *
 *      this.aCounts.nCyclesPerYield         (this.aCounts.nCyclesPerSecond / CPU.YIELDS_PER_SECOND)
 *      this.aCounts.nCyclesPerVideoUpdate   (this.aCounts.nCyclesPerSecond / CPU.VIDEO_UPDATES_PER_SECOND)
 *      this.aCounts.nCyclesPerStatusUpdate  (this.aCounts.nCyclesPerSecond / CPU.STATUS_UPDATES_PER_SECOND)
 *
 * The above variables are also multiplied by any cycle multiplier in effect, via setSpeed(),
 * and then they're used to initialize another set of variables for each runCPU() iteration:
 *
 *      this.aCounts.nCyclesNextYield        <= this.aCounts.nCyclesPerYield
 *      this.aCounts.nCyclesNextVideoUpdate  <= this.aCounts.nCyclesPerVideoUpdate
 *      this.aCounts.nCyclesNextStatusUpdate <= this.aCounts.nCyclesPerStatusUpdate
 */
CPU.YIELDS_PER_SECOND         = 30;
CPU.VIDEO_UPDATES_PER_SECOND  = 60;     // WARNING: if you change this, beware of side-effects in the Video component
CPU.STATUS_UPDATES_PER_SECOND = 2;

/**
 * initBus(cmp, bus, cpu, dbg)
 *
 * @this {CPU}
 * @param {Computer} cmp
 * @param {Bus} bus
 * @param {CPU} cpu
 * @param {Debugger} dbg
 */
CPU.prototype.initBus = function(cmp, bus, cpu, dbg)
{
    this.bus = bus;
    this.dbg = dbg;
    this.cmp = cmp;
    /*
     * Attach the Video component to the CPU, so that the CPU can periodically update
     * the video display via displayVideo(), as cycles permit.
     */
    var video = cmp.getComponentByType("Video");
    if (video) {
        this.displayVideo = function onDisplayVideo() {
            video.updateScreen();
        };
        this.setFocus = function onSetFocus() {
            video.setFocus();
        };
    }
    /*
     * Attach the ChipSet component to the CPU, so that it can obtain the IDT vector number of
     * pending hardware interrupts, in response to ChipSet's updateINTR() notifications.
     *
     * We must also call chipset.updateAllTimers() periodically; stepCPU() takes care of that.
     */
    this.chipset = cmp.getComponentByType("ChipSet");
    this.setReady();
};

/**
 * reset()
 *
 * This is a placeholder for reset (overridden by the X86CPU component).
 *
 * @this {CPU}
 */
CPU.prototype.reset = function()
{
};

/**
 * save()
 *
 * This is a placeholder for save support (overridden by the X86CPU component).
 *
 * @this {CPU}
 * @return {Object|null}
 */
CPU.prototype.save = function()
{
    return null;
};

/**
 * restore(data)
 *
 * This is a placeholder for restore support (overridden by the X86CPU component).
 *
 * @this {CPU}
 * @param {Object} data
 * @return {boolean} true if restore successful, false if not
 */
CPU.prototype.restore = function(data)
{
    return false;
};

/**
 * powerUp(data, fRepower)
 *
 * @this {CPU}
 * @param {Object|null} data
 * @param {boolean} [fRepower]
 * @return {boolean} true if successful, false if failure
 */
CPU.prototype.powerUp = function(data, fRepower)
{
    if (!fRepower) {
        if (!data || !this.restore) {
            this.reset();
        } else {
            this.resetCycles();
            if (!this.restore(data)) return false;
            this.resetChecksum();
        }
        /*
         * Give the Debugger a chance to do/print something once we've powered up (TODO: Review the necessity of this)
         */
        if (DEBUGGER && this.dbg) {
            this.dbg.init();
        } else {
            /*
             * The Computer (this.cmp) knows if there's a Control Panel (this.cmp.panel), and the Control Panel
             * knows if there's a "print" control (this.cmp.panel.controlPrint), and if there IS a "print" control
             * but no debugger, the machine is probably misconfigured (most likely, the page simply neglected to
             * load the Debugger component).
             *
             * However, we don't actually need to check all that; it's always safe use println(), regardless whether
             * a Control Panel with a "print" control is present or not.
             */
            this.println("No debugger detected");
        }
    }
    this.bitField.fPowered = true;
    if (!this.autoStart() && this.dbg) this.dbg.updateStatus();
    this.updateCPU();
    return true;
};

/**
 * powerDown(fSave)
 *
 * @this {CPU}
 * @param {boolean} fSave
 * @return {Object|boolean}
 */
CPU.prototype.powerDown = function(fSave)
{
    this.bitField.fPowered = false;
    return fSave && this.save ? this.save() : true;
};

/**
 * autoStart()
 *
 * @this {CPU}
 * @return {boolean} true if started, false if not
 */
CPU.prototype.autoStart = function()
{
    if (this.bitField.fAutoStart === true || this.bitField.fAutoStart === null && (!DEBUGGER || !this.dbg) && this.bindings["run"] === undefined) {
        this.runCPU();      // start running automatically on power-up, assuming there's no Debugger
        return true;
    }
    return false;
};

/**
 * setFocus()
 *
 * @this {CPU}
 */
CPU.prototype.setFocus = function()
{
    /*
     * Nothing to do until powerUp() installs a replacement function
     */
};

/**
 * isPowered()
 *
 * @this {CPU}
 * @return {boolean}
 */
CPU.prototype.isPowered = function()
{
    if (!this.bitField.fPowered) {
        this.println(this.toString() + " not powered");
        return false;
    }
    return true;
};

/**
 * isRunning()
 *
 * @this {CPU}
 * @return {boolean}
 */
CPU.prototype.isRunning = function()
{
    return this.bitField.fRunning;
};

/**
 * getChecksum()
 *
 * This will be implemented by the X86CPU component.
 *
 * @this {CPU}
 * @return {number} a 32-bit summation of key elements of the current CPU state (used by the CPU checksum code)
 */
CPU.prototype.getChecksum = function()
{
    return 0;
};

/**
 * resetChecksum()
 *
 * If checksum generation is enabled (fChecksum is true), this resets the running 32-bit checksum and the
 * cycle counter that will trigger the next displayChecksum(); called by resetCycles(), which is called whenever
 * the CPU is reset or restored.
 *
 * @this {CPU}
 * @return {boolean} true if checksum generation enabled, false if not
 */
CPU.prototype.resetChecksum = function()
{
    if (this.aCounts.nCyclesChecksumStart === undefined) this.aCounts.nCyclesChecksumStart = 0;
    if (this.aCounts.nCyclesChecksumInterval === undefined) this.aCounts.nCyclesChecksumInterval = -1;
    if (this.aCounts.nCyclesChecksumStop === undefined) this.aCounts.nCyclesChecksumStop = -1;
    this.bitField.fChecksum = (this.aCounts.nCyclesChecksumStart >= 0 && this.aCounts.nCyclesChecksumInterval > 0);
    if (this.bitField.fChecksum) {
        this.aCounts.nChecksum = 0;
        this.aCounts.nCyclesChecksumNext = this.aCounts.nCyclesChecksumStart - this.nTotalCycles;
        // this.aCounts.nCyclesChecksumNext = this.aCounts.nCyclesChecksumStart + this.aCounts.nCyclesChecksumInterval - (this.nTotalCycles % this.aCounts.nCyclesChecksumInterval);
        return true;
    }
    return false;
};

/**
 * updateChecksum(nCycles)
 *
 * When checksum generation is enabled (fChecksum is true), runCPU() asks stepCPU() to execute a minimum
 * number of cycles (1), effectively limiting execution to a single instruction, and then we're called with
 * the exact number cycles that were actually executed.  This should give us instruction-granular checksums
 * at precise intervals that are 100% repeatable.
 *
 * @this {CPU}
 * @param {number} nCycles
 */
CPU.prototype.updateChecksum = function(nCycles)
{
    if (this.bitField.fChecksum) {
        /*
         * Get a 32-bit summation of the current CPU state and add it to our running 32-bit checksum
         */
        var fDisplay = false;
        this.aCounts.nChecksum = (this.aCounts.nChecksum + this.getChecksum()) | 0;
        this.aCounts.nCyclesChecksumNext -= nCycles;
        if (this.aCounts.nCyclesChecksumNext <= 0) {
            this.aCounts.nCyclesChecksumNext += this.aCounts.nCyclesChecksumInterval;
            fDisplay = true;
        }
        if (this.aCounts.nCyclesChecksumStop >= 0) {
            if (this.aCounts.nCyclesChecksumStop <= this.getCycles()) {
                this.aCounts.nCyclesChecksumInterval = this.aCounts.nCyclesChecksumStop = -1;
                this.resetChecksum();
                this.stopCPU();
                fDisplay = true;
            }
        }
        if (fDisplay) this.displayChecksum();
    }
};

/**
 * displayChecksum()
 *
 * When checksum generation is enabled (fChecksum is true), this is called to provide a crude log of all
 * checksums generated at the specified cycle intervals, as specified by the "csStart" and "csInterval" parmsCPU
 * properties).
 *
 * @this {CPU}
 */
CPU.prototype.displayChecksum = function()
{
    this.println(this.getCycles() + " cycles: " + "checksum=" + str.toHex(this.aCounts.nChecksum));
};

/**
 * displayReg(sReg, nVal, cch)
 *
 * @this {CPU}
 * @param {string} sReg
 * @param {number} nVal
 * @param {number} [cch] default is 4
 */
CPU.prototype.displayReg = function(sReg, nVal, cch)
{
    if (this.bindings[sReg]) {
        if (cch === undefined) cch = 4;
        if (nVal === undefined) {
            this.setError("Register " + sReg + " is invalid");
            this.stopCPU();
        }
        var sVal;
        if (!this.bitField.fRunning || this.bitField.fDisplayLiveRegs) {
            sVal = str.toHex(nVal, cch);
        } else {
            sVal = "----".substr(0, cch);
        }
        /*
         * TODO: Determine if this test actually avoids any redrawing when a register hasn't changed, and/or if
         * we should maintain our own (numeric) cache of displayed register values (to avoid creating these temporary
         * string values that will have to garbage-collected), and/or if this is actually slower, and/or if I'm being
         * too obsessive.
         */
        if (this.bindings[sReg].textContent != sVal) this.bindings[sReg].textContent = sVal;
    }
};

/**
 * displayStatus()
 *
 * This will be implemented by the X86CPU component.
 *
 * @this {CPU}
 * @param {boolean} [fForce]
 */
CPU.prototype.displayStatus = function(fForce)
{
};

/**
 * displayVideo()
 *
 * @this {CPU}
 */
CPU.prototype.displayVideo = function()
{
    /*
     * Nothing to do until powerUp() installs a replacement function
     */
};

/**
 * setBinding(sHTMLType, sBinding, control)
 *
 * @this {CPU}
 * @param {string|null} sHTMLType is the type of the HTML control (eg, "button", "list", "text", "submit", "textarea", "canvas")
 * @param {string} sBinding is the value of the 'binding' parameter stored in the HTML control's "data-value" attribute (eg, "run")
 * @param {Object} control is the HTML control DOM object (eg, HTMLButtonElement)
 * @return {boolean} true if binding was successful, false if unrecognized binding request
 */
CPU.prototype.setBinding = function(sHTMLType, sBinding, control)
{
    var cpu = this;
    var fBound = false;
    switch (sBinding) {
    case "run":
        this.bindings[sBinding] = control;
        control.onclick = function onClickRun() {
            if (!cpu.bitField.fRunning)
                cpu.runCPU(true);
            else
                cpu.stopCPU(true);
        };
        fBound = true;
        break;

    case "reset":
        /*
         * A "reset" button is really a function of the entire computer, not just the CPU, but
         * it's not always convenient to stick a reset button in the computer component definition,
         * so we support a "reset" binding both here AND in the Computer component.
         */
        this.bindings[sBinding] = control;
        control.onclick = function onClickReset() {
            if (cpu.cmp) cpu.cmp.onReset();
        };
        fBound = true;
        break;

    case "speed":
        this.bindings[sBinding] = control;
        fBound = true;
        break;

    case "setSpeed":
        this.bindings[sBinding] = control;
        control.onclick = function onClickSetSpeed() {
            cpu.setSpeed(cpu.aCounts.nCyclesMultiplier << 1, true);
        };
        control.textContent = this.getSpeedTarget();
        fBound = true;
        break;

    default:
        break;
    }
    return fBound;
};

/**
 * setBurstCycles(nCycles)
 *
 * This function is used by the ChipSet component whenever a very low timer count is set,
 * in anticipation of the timer requiring an update sooner than the normal nCyclesPerYield
 * period in runCPU() would normally provide.
 *
 * @this {CPU}
 * @param {number} nCycles is the target number of cycles to drop the current burst to
 * @return {boolean}
 */
CPU.prototype.setBurstCycles = function(nCycles)
{
    if (this.bitField.fRunning) {
        var nDelta = this.nStepCycles - nCycles;
        /*
         * NOTE: If nDelta is negative, we will actually be increasing nStepCycles and nBurstCycles.
         * Which is OK, but if we're also taking snapshots of the cycle counts, to make sure that instruction
         * costs are being properly assessed, then we need to update nSnapCycles as well.
         */
        if (DEBUG) this.nSnapCycles -= nDelta;
        this.nStepCycles -= nDelta;
        this.nBurstCycles -= nDelta;
        return true;
    }
    return false;
};

/**
 * addCycles(nCycles, fEndStep)
 *
 * @this {CPU}
 * @param {number} nCycles
 * @param {boolean} [fEndStep]
 */
CPU.prototype.addCycles = function(nCycles, fEndStep)
{
    this.nTotalCycles += nCycles;
    if (fEndStep) {
        this.nBurstCycles = this.nStepCycles = 0;
    }
};

/**
 * calcCycles(fRecalc)
 *
 * Calculate the number of cycles to process for each "burst" of CPU activity.  The size of a burst
 * is driven by the following values:
 *
 *      CPU.YIELDS_PER_SECOND (eg, 30)
 *      CPU.VIDEO_UPDATES_PER_SECOND (eg, 60)
 *      CPU.STATUS_UPDATES_PER_SECOND (eg, 5)
 *
 * The largest of the above values forces the size of the burst to its smallest value.  Let's say that
 * largest value is 30.  Assuming nCyclesPerSecond is 1,000,000, that results in bursts of 33,333 cycles.
 *
 * At the end of each burst, we subtract burst cycles from yield, video, and status cycle "threshold"
 * counters. Whenever the "next yield" cycle counter goes to (or below) zero, we compare elapsed time
 * to the time we expected the virtual hardware to take (eg, 1000ms/50 or 20ms), and if we still have time
 * remaining, we sleep the remaining time (or 0ms if there's no remaining time), and then restart runCPU().
 *
 * Similarly, whenever the "next video update" cycle counter goes to (or below) zero, we call displayVideo(),
 * and whenever the "next status update" cycle counter goes to (or below) zero, we call displayStatus().
 *
 * @this {CPU}
 * @param {boolean} [fRecalc] is true if the caller wants to recalculate thresholds based on the most recent
 * speed calculation (see calcSpeed).
 */
CPU.prototype.calcCycles = function(fRecalc)
{
    /*
     * Calculate the most cycles we're allowed to execute in a single "burst"
     */
    var nMostUpdatesPerSecond = CPU.YIELDS_PER_SECOND;
    if (nMostUpdatesPerSecond < CPU.VIDEO_UPDATES_PER_SECOND) nMostUpdatesPerSecond = CPU.VIDEO_UPDATES_PER_SECOND;
    if (nMostUpdatesPerSecond < CPU.STATUS_UPDATES_PER_SECOND) nMostUpdatesPerSecond = CPU.STATUS_UPDATES_PER_SECOND;

    /*
     * Calculate cycle "per" values for the yield, video update, and status update cycle counters
     */
    var vMultiplier = 1;
    if (fRecalc) {
        if (this.aCounts.nCyclesMultiplier > 1 && this.aCounts.mhz) {
            vMultiplier = (this.aCounts.mhz / this.aCounts.mhzDefault);
        }
    }

    this.aCounts.msPerYield = Math.round(1000 / CPU.YIELDS_PER_SECOND);
    this.aCounts.nCyclesPerBurst = Math.floor(this.aCounts.nCyclesPerSecond / nMostUpdatesPerSecond * vMultiplier);
    this.aCounts.nCyclesPerYield = Math.floor(this.aCounts.nCyclesPerSecond / CPU.YIELDS_PER_SECOND * vMultiplier);
    this.aCounts.nCyclesPerVideoUpdate = Math.floor(this.aCounts.nCyclesPerSecond / CPU.VIDEO_UPDATES_PER_SECOND * vMultiplier);
    this.aCounts.nCyclesPerStatusUpdate = Math.floor(this.aCounts.nCyclesPerSecond / CPU.STATUS_UPDATES_PER_SECOND * vMultiplier);

    /*
     * And initialize "next" yield, video update, and status update cycle "threshold" counters to those "per" values
     */
    if (!fRecalc) {
        this.aCounts.nCyclesNextYield = this.aCounts.nCyclesPerYield;
        this.aCounts.nCyclesNextVideoUpdate = this.aCounts.nCyclesPerVideoUpdate;
        this.aCounts.nCyclesNextStatusUpdate = this.aCounts.nCyclesPerStatusUpdate;
    }
    this.aCounts.nCyclesRecalc = 0;
};

/**
 * getCycles(fScaled)
 *
 * getCycles() returns the number of cycles executed so far.  Note that we can be called after
 * runCPU() OR during runCPU(), perhaps from a handler triggered during the current run's stepCPU(),
 * so nRunCycles must always be adjusted by number of cycles stepCPU() was asked to run (nBurstCycles),
 * less the number of cycles it has yet to run (nStepCycles).
 *
 * nRunCycles is zeroed whenever the CPU is halted or the CPU speed is changed, which is why we also
 * have nTotalCycles, which accumulates all nRunCycles before we zero it.  However, nRunCycles and
 * nTotalCycles eventually get reset by calcSpeed(), to avoid overflow, so components that rely on
 * getCycles() returning steadily increasing values should also be prepared for a reset at any time.
 *
 * @this {CPU}
 * @param {boolean} [fScaled] is true if the caller wants a cycle count relative to a multiplier of 1
 * @return {number}
 */
CPU.prototype.getCycles = function(fScaled)
{
    var nCycles = this.nTotalCycles + this.nRunCycles + this.nBurstCycles - this.nStepCycles;
    if (fScaled && this.aCounts.nCyclesMultiplier > 1 && this.aCounts.mhz > this.aCounts.mhzDefault) {
        /*
         * We could scale the current cycle count by the current effective speed (this.aCounts.mhz); eg:
         *
         *      nCycles = Math.round(nCycles / (this.aCounts.mhz / this.aCounts.mhzDefault));
         *
         * but that speed will fluctuate somewhat: large fluctuations at first, but increasingly smaller
         * fluctuations after each burst of instructions that runCPU() executes.
         *
         * Alternatively, we can scale the cycle count by the multiplier, which is good in that the
         * multiplier doesn't vary once the user changes it, but a potential downside is that the
         * multiplier might be set too high, resulting in a target speed that's higher than the effective
         * speed is able to reach.
         *
         * Also, if multipliers were always limited to a power-of-two, then this could be calculated
         * with a simple shift.  However, only the "setSpeed" UI binding limits it that way; the Debugger
         * interface allows any value, as does the CPU "multiplier" parmsCPU property (from the machine's
         * XML file).
         */
        nCycles = Math.round(nCycles / this.aCounts.nCyclesMultiplier);
    }
    return nCycles;
};

/**
 * getCyclesPerSecond()
 *
 * This returns the CPU's "base" speed (ie, the original cycles per second defined for the machine)
 *
 * @this {CPU}
 * @return {number}
 */
CPU.prototype.getCyclesPerSecond = function()
{
    return this.aCounts.nCyclesPerSecond;
};

/**
 * resetCycles()
 *
 * Resets speed and cycle information as part of any reset() or restore(); this typically occurs during powerUp().
 * It's important that this be called BEFORE the actual restore() call, because restore() may want to call setSpeed(),
 * which in turn assumes that all the cycle counts have been initialized to sensible values.
 *
 * @this {CPU}
 */
CPU.prototype.resetCycles = function()
{
    this.aCounts.mhz = 0;
    this.nTotalCycles = this.nRunCycles = this.nBurstCycles = this.nStepCycles = 0;
    this.resetChecksum();
    this.setSpeed(1);
};

/**
 * getSpeed()
 *
 * @this {CPU}
 * @return {number} the current speed multiplier
 */
CPU.prototype.getSpeed = function() {
    return this.aCounts.nCyclesMultiplier;
};

/**
 * getSpeedCurrent()
 *
 * @this {CPU}
 * @return {string} the current speed, in mhz, as a string formatted to two decimal places
 */
CPU.prototype.getSpeedCurrent = function() {
    /*
     * TODO: Has toFixed() been "fixed" in all browsers (eg, IE) to return a rounded value now?
     */
    return ((this.bitField.fRunning && this.aCounts.mhz)? (this.aCounts.mhz.toFixed(2) + "Mhz") : "Stopped");
};

/**
 * getSpeedTarget()
 *
 * @this {CPU}
 * @return {string} the target speed, in mhz, as a string formatted to two decimal places
 */
CPU.prototype.getSpeedTarget = function() {
    /*
     * TODO: Has toFixed() been "fixed" in all browsers (eg, IE) to return a rounded value now?
     */
    return this.aCounts.mhzTarget.toFixed(2) + "Mhz";
};

/**
 * setSpeed(nMultiplier, fOnClick)
 *
 * @this {CPU}
 * @param {number} [nMultiplier] is the new proposed multiplier (reverts to 1 if the target was too high)
 * @param {boolean} [fOnClick] is true if called from a click handler that might have stolen focus
 * @return {number} the target speed, in mhz
 * @desc Whenever the speed is changed, the running cycle count and corresponding start time must be reset,
 * so that the next effective speed calculation obtains sensible results.  In fact, when runCPU() initially calls
 * setSpeed() with no parameters, that's all this function does (it doesn't change the current speed setting).
 */
CPU.prototype.setSpeed = function(nMultiplier, fOnClick)
{
    if (nMultiplier !== undefined) {
        /*
         * If we couldn't reach at least 80% (0.8) of the current target speed,
         * then revert the multiplier back to one.
         */
        if (this.aCounts.mhz / this.aCounts.mhzTarget < 0.8) nMultiplier = 1;
        this.aCounts.nCyclesMultiplier = nMultiplier;
        var mhz = this.aCounts.mhzDefault * this.aCounts.nCyclesMultiplier;
        if (this.aCounts.mhzTarget != mhz) {
            this.aCounts.mhzTarget = mhz;
            var sSpeed = this.getSpeedTarget();
            var controlSpeed = this.bindings["setSpeed"];
            if (controlSpeed) controlSpeed.textContent = sSpeed;
            this.println("target speed: " + sSpeed);
        }
        if (fOnClick) this.setFocus();
    }
    this.addCycles(this.nRunCycles);
    this.nRunCycles = 0;
    this.aCounts.msStartRun = usr.getTime();
    this.aCounts.msEndThisRun = 0;
    this.calcCycles();
    return this.aCounts.mhzTarget;
};

/**
 * calcSpeed(nCycles, msElapsed)
 *
 * @this {CPU}
 * @param {number} nCycles
 * @param {number} msElapsed
 */
CPU.prototype.calcSpeed = function(nCycles, msElapsed)
{
    if (msElapsed) {
        this.aCounts.mhz = Math.round(nCycles / (msElapsed * 10)) / 100;
        if (msElapsed >= 86400000) {
            this.nTotalCycles = 0;
            if (this.chipset) this.chipset.updateAllTimers(true);
            this.setSpeed();        // reset all counters once per day so that we never have to worry about overflow
        }
    }
};

/**
 * calcStartTime()
 *
 * @this {CPU}
 */
CPU.prototype.calcStartTime = function()
{
    if (this.aCounts.nCyclesRecalc >= this.aCounts.nCyclesPerSecond) {
        this.calcCycles(true);
    }
    this.aCounts.nCyclesThisRun = 0;
    this.aCounts.msStartThisRun = usr.getTime();

    /*
     * Try to detect situations where the browser may have throttled us, such as when the user switches
     * to a different tab; in those situations, Chrome and Safari may restrict setTimeout() callbacks
     * to roughly one per second.
     *
     * Another scenario: the user resizes the browser window.  setTimeout() callbacks are not throttled,
     * but there can still be enough of a lag between the callbacks that CPU speed will be noticeably
     * erratic if we don't compensate for it here.
     *
     * We can detect throttling/lagging by verifying that msEndThisRun (which was set at the end of the
     * previous run and includes any requested sleep time) is comparable to the current msStartThisRun;
     * if the delta is significant, we compensate by bumping msStartRun forward by that delta.
     *
     * This shouldn't be triggered when the Debugger halts the CPU, because setSpeed() -- which is called
     * whenever the CPU starts running again -- zeroes msEndThisRun.
     *
     * This also won't do anything about other internal delays; for example, Debugger message() calls.
     * By the time the message() function has called yieldCPU(), the cost of the message has already been
     * incurred, so it will be end up being charged against the instruction(s) that triggered them.
     *
     * TODO: Consider calling yieldCPU() sooner from message(), so that it can arrange for the msEndThisRun
     * "snapshot" to occur sooner; it's unclear, however, whether that will really improve the CPU's ability
     * to hit its target speed, since you would expect any instruction that displays a message to be an
     * EXTREMELY slow instruction.
     */
    if (this.aCounts.msEndThisRun) {
        var msDelta = this.aCounts.msStartThisRun - this.aCounts.msEndThisRun;
        if (msDelta > this.aCounts.msPerYield) {
            if (MAXDEBUG) this.println("large time delay: " + msDelta + "ms");
            this.aCounts.msStartRun += msDelta;
            /*
             * Bumping msStartRun forward should NEVER cause it to exceed msStartThisRun; however, just
             * in case, I make absolutely sure it cannot happen, since doing so could result in negative
             * speed calculations.
             */
            if (DEBUG) this.assert(this.aCounts.msStartRun <= this.aCounts.msStartThisRun);
            if (this.aCounts.msStartRun > this.aCounts.msStartThisRun) {
                this.aCounts.msStartRun = this.aCounts.msStartThisRun;
            }
        }
    }
};

/**
 * calcRemainingTime()
 *
 * @this {CPU}
 * @return {number}
 */
CPU.prototype.calcRemainingTime = function()
{
    this.aCounts.msEndThisRun = usr.getTime();

    var msYield = this.aCounts.msPerYield;
    if (this.aCounts.nCyclesThisRun) {
        /*
         * Normally, we would assume we executed a full quota of work over msPerYield, but since the CPU
         * now has the option of calling yieldCPU(), that might not be true.  If nCyclesThisRun is correct, then
         * the ratio of nCyclesThisRun/nCyclesPerYield should represent the percentage of work we performed,
         * and so applying that percentage to msPerYield should give us a better estimate of work vs. time.
         */
        msYield = Math.round(msYield * this.aCounts.nCyclesThisRun / this.aCounts.nCyclesPerYield);
    }

    var msElapsedThisRun = this.aCounts.msEndThisRun - this.aCounts.msStartThisRun;
    var msRemainsThisRun = msYield - msElapsedThisRun;

    /*
     * We could pass only "this run" results to calcSpeed():
     *
     *      nCycles = this.aCounts.nCyclesThisRun;
     *      msElapsed = msElapsedThisRun;
     *
     * but it seems preferable to use longer time periods and hopefully get a more accurate speed.
     *
     * Also, if msRemainsThisRun >= 0 && this.aCounts.nCyclesMultiplier == 1, we could pass these results instead:
     *
     *      nCycles = this.aCounts.nCyclesThisRun;
     *      msElapsed = this.aCounts.msPerYield;
     *
     * to insure that we display a smooth, constant N Mhz.  But for now, I prefer seeing any fluctuations.
     */
    var nCycles = this.nRunCycles;
    var msElapsed = this.aCounts.msEndThisRun - this.aCounts.msStartRun;

    if (MAXDEBUG && msRemainsThisRun < 0 && this.aCounts.nCyclesMultiplier > 1) {
        this.println("warning: updates @" + msElapsedThisRun + "ms (prefer " + Math.round(msYield) + "ms)");
    }

    this.calcSpeed(nCycles, msElapsed);

    if (msRemainsThisRun < 0 || this.aCounts.mhz < this.aCounts.mhzTarget) {
        /*
         * If the last burst took MORE time than we allotted (ie, it's taking more than 1 second to simulate
         * nCyclesPerSecond), all we can do is yield for as little time as possible (ie, 0ms) and hope that the
         * simulation is at least usable.
         */
        msRemainsThisRun = 0;
    }

    /*
     * Last but not least, update nCyclesRecalc, so that when runCPU() starts up again and calls calcStartTime(),
     * it'll be ready to decide if calcCycles() should be called again.
     */
    this.aCounts.nCyclesRecalc += this.aCounts.nCyclesThisRun;

    if (DEBUG && this.dbg && this.dbg.messageEnabled(Debugger.MESSAGE.LOG) && msRemainsThisRun) {
        this.log("calcRemainingTime: " + msRemainsThisRun + "ms to sleep after " + this.aCounts.msEndThisRun + "ms");
    }

    this.aCounts.msEndThisRun += msRemainsThisRun;
    return msRemainsThisRun;
};

/**
 * runCPU(fOnClick)
 *
 * @this {CPU}
 * @param {boolean} [fOnClick] is true if called from a click handler that might have stolen focus
 */
CPU.prototype.runCPU = function(fOnClick)
{
    if (!this.setBusy(true)) {
        this.updateCPU();
        if (this.cmp) this.cmp.stop(usr.getTime(), this.getCycles());
        return;
    }

    this.startCPU(fOnClick);

    /*
     *  calcStartTime() initializes the cycle counter and timestamp for this runCPU() invocation, and optionally
     *  recalculates the the maximum number of cycles for each burst if the nCyclesRecalc threshold has been reached.
     */
    this.calcStartTime();
    try {
        do {
            var nCyclesPerBurst = (this.bitField.fChecksum? 1 : this.aCounts.nCyclesPerBurst);

            if (this.chipset) {
                this.chipset.updateAllTimers();
                nCyclesPerBurst = this.chipset.getTimerCycleLimit(0, nCyclesPerBurst);
                nCyclesPerBurst = this.chipset.getRTCCycleLimit(nCyclesPerBurst);
            }

            /*
             * nCyclesPerBurst is how many cycles we WANT to run on each iteration of stepCPU(), but it may run
             * significantly less (or slightly more, since we can't execute partial instructions).
             */
            this.stepCPU(nCyclesPerBurst);

            /*
             * nBurstCycles, less any remaining nStepCycles, is how many cycles stepCPU() ACTUALLY ran (nCycles).
             * We add that to nCyclesThisRun, as well as nRunCycles, which is the cycle count since the CPU first
             * started running.
             */
            var nCycles = this.nBurstCycles - this.nStepCycles;
            this.nRunCycles += nCycles;
            this.aCounts.nCyclesThisRun += nCycles;
            this.addCycles(0, true);
            this.updateChecksum(nCycles);

            this.aCounts.nCyclesNextVideoUpdate -= nCycles;
            if (this.aCounts.nCyclesNextVideoUpdate <= 0) {
                this.aCounts.nCyclesNextVideoUpdate += this.aCounts.nCyclesPerVideoUpdate;
                this.displayVideo();
            }

            this.aCounts.nCyclesNextStatusUpdate -= nCycles;
            if (this.aCounts.nCyclesNextStatusUpdate <= 0) {
                this.aCounts.nCyclesNextStatusUpdate += this.aCounts.nCyclesPerStatusUpdate;
                this.displayStatus();
            }

            this.aCounts.nCyclesNextYield -= nCycles;
            if (this.aCounts.nCyclesNextYield <= 0) {
                this.aCounts.nCyclesNextYield += this.aCounts.nCyclesPerYield;
                break;
            }
        } while (this.bitField.fRunning);
    }
    catch (e) {
        this.stopCPU();
        this.updateCPU();
        if (this.cmp) this.cmp.stop(usr.getTime(), this.getCycles());
        this.setBusy(false);
        this.setError(e.message);
        return;
    }
    setTimeout(this.onRunTimeout, this.calcRemainingTime());
};

/**
 * startCPU(fSetFocus)
 *
 * WARNING: Other components must use runCPU() to get the CPU running; This is a runCPU() helper function only; o
 *
 * @param {boolean} [fSetFocus]
 */
CPU.prototype.startCPU = function(fSetFocus)
{
    if (!this.bitField.fRunning) {
        /*
         *  setSpeed() without a speed parameter leaves the selected speed in place, but also resets the
         *  cycle counter and timestamp for the current series of runCPU() calls, calculates the maximum number
         *  of cycles for each burst based on the last known effective CPU speed, and resets the nCyclesRecalc
         *  threshold counter.
         */
        this.setSpeed();
        if (this.cmp) this.cmp.start(this.aCounts.msStartRun, this.getCycles());
        this.bitField.fRunning = true;
        this.bitField.fStarting = true;
        if (this.chipset) this.chipset.setSpeaker();
        var controlRun = this.bindings["run"];
        if (controlRun) controlRun.textContent = "Halt";
        this.displayStatus(true);
        if (fSetFocus) this.setFocus();
    }
};

/**
 * stepCPU(nMinCycles)
 *
 * This will be implemented by the X86CPU component.
 *
 * @this {CPU}
 * @param {number} nMinCycles (0 implies a single-step, and therefore breakpoints should be ignored)
 * @return {number} of cycles executed; 0 indicates that the last instruction was not executed
 */
CPU.prototype.stepCPU = function(nMinCycles)
{
    return 0;
};

/**
 * stopCPU(fComplete)
 *
 * For use by any component that wants to stop the CPU.
 *
 * This similar to yieldCPU(), but it doesn't need to zero nCyclesNextYield to break out of runCPU();
 * it simply needs to clear fRunning (well, "simply" may be oversimplifying a bit....)
 *
 * @this {CPU}
 * @param {boolean} [fComplete]
 */
CPU.prototype.stopCPU = function(fComplete)
{
    this.isBusy(true);
    this.nBurstCycles -= this.nStepCycles;
    this.nStepCycles = 0;
    this.addCycles(this.nRunCycles);
    this.nRunCycles = 0;
    if (this.bitField.fRunning) {
        this.bitField.fRunning = false;
        if (this.chipset) this.chipset.setSpeaker();
        var controlRun = this.bindings["run"];
        if (controlRun) controlRun.textContent = "Run";
    }
    this.bitField.fComplete = fComplete;
};

/**
 * updateCPU()
 *
 * This used to be performed at the end of every stepCPU(), but runCPU() -- which relies upon
 * stepCPU() -- needed to have more control over when these updates are performed.  However, for
 * other callers of stepCPU(), such as the Debugger, the combination of stepCPU() + updateCPU()
 * provides the old behavior.
 *
 * @this {CPU}
 */
CPU.prototype.updateCPU = function()
{
    this.displayVideo();
    this.displayStatus();
};

/**
 * yieldCPU()
 *
 * Similar to stopCPU() with regard to how it resets various cycle countdown values, but the CPU
 * remains in a "running" state.
 *
 * @this {CPU}
 */
CPU.prototype.yieldCPU = function()
{
    this.aCounts.nCyclesNextYield = 0;   // this will break us out of runCPU(), once we break out of stepCPU()
    this.nBurstCycles -= this.nStepCycles;
    this.nStepCycles = 0;               // this will break us out of stepCPU()
    /*
     * The Debugger calls yieldCPU() after every message() to ensure browser responsiveness, but it looks
     * odd for those messages to show CPU state changes but for the CPU's own status display to not (ditto
     * for the Video display), so I've added this call to try to keep things looking synchronized.
     */
    this.updateCPU();
};

if (typeof APP_PCJS !== 'undefined') APP_PCJS.CPU = CPU;

if (typeof module !== 'undefined') module.exports = CPU;
