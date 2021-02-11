/* eslint-disable @typescript-eslint/no-unused-vars */

import { ApiCallResult } from '@/background/scrobbler/api-call-result';
import { Pipeline } from '@/background/pipeline/pipeline';
import { SavedEdits } from '@/background/storage/saved-edits';
import { ScrobbleStorage } from '@/background/storage/scrobble-storage';
import { Song } from '@/background/model/song/Song';
import { Timer } from '@/background/object/timer';

import {
	areAllResults,
	debugLog,
	getSecondsToScrobble,
	isAnyResult,
	isStateEmpty,
	LogType,
} from '@/background/util/util';
import {
	getOption,
	SCROBBLE_PERCENT,
	SCROBBLE_PODCASTS,
} from '@/background/storage/options';

import { ControllerMode } from '@/background/object/controller-mode';
import { ParsedSongInfo, EditedSongInfo } from '@/background/object/song';
import { ConnectorEntry } from '@/common/connector-entry';
import { ScrobblerManager } from '@/background/scrobbler/ScrobblerManager';
import { NowPlayingListener } from '@/background/object/controller/NowPlayingListener';
import { ModeChangeListener } from '@/background/object/controller/ModeChangeListener';
import { SongUpdateListener } from '@/background/object/controller/SongUpdateListener';
import { LoveStatus } from '@/background/model/song/LoveStatus';
import { SongImpl } from '@/background/model/song/SongImpl';
import { ConnectorState } from '@/background/model/ConnectorState';
import { Processor } from '@/background/pipeline/Processor';

/**
 * List of song fields used to check if song is changed. If any of
 * these fields are changed, the new song is playing.
 */
const fieldsToCheckSongChange = [
	'artist',
	'track',
	'album',
	'uniqueID',
] as const;

/**
 * Object that handles song playback and scrobbling actions.
 */
export class Controller {
	mode: ControllerMode;
	tabId: number;
	isEnabled: boolean;
	connector: ConnectorEntry;

	currentSong: Song;
	playbackTimer: Timer;
	replayDetectionTimer: Timer;

	isReplayingSong = false;
	shouldScrobblePodcasts: boolean;

	private nowPlayingListener: NowPlayingListener;
	private songUpdateListener: SongUpdateListener;
	private modeListener: ModeChangeListener;

	private previousState: ConnectorState;

	constructor(
		tabId: number,
		connector: ConnectorEntry,
		isEnabled: boolean,
		private scrobblerManager: ScrobblerManager,
		private songPipeline: Processor<Song>
	) {
		this.tabId = tabId;
		this.connector = connector;
		this.isEnabled = isEnabled;
		this.mode = isEnabled ? ControllerMode.Base : ControllerMode.Disabled;

		this.playbackTimer = new Timer();
		this.replayDetectionTimer = new Timer();

		this.currentSong = null;
		this.shouldScrobblePodcasts = getOption(SCROBBLE_PODCASTS);

		this.debugLog(`Created controller for ${connector.label} connector`);
	}

	/** Listeners. */

	setSongUpdateListener(listener: SongUpdateListener): void {
		this.songUpdateListener = listener;
	}

	setModeListener(listener: ModeChangeListener): void {
		this.modeListener = listener;
	}

	setNowPlayingListener(listener: NowPlayingListener): void {
		this.nowPlayingListener = listener;
	}

	/** Public functions */

	/**
	 * Switch the state of controller.
	 *
	 * @param flag True means enabled and vice versa
	 */
	setEnabled(flag: boolean): void {
		this.isEnabled = flag;

		if (flag) {
			this.setMode(ControllerMode.Base);
		} else {
			this.resetState();
			this.setMode(ControllerMode.Disabled);
		}
	}

	/**
	 * Do finalization before unloading controller.
	 */
	finish(): void {
		this.debugLog(
			`Remove controller for ${this.connector.label} connector`
		);
		this.resetState();
	}

	/**
	 * Reset song data and process it again.
	 */
	resetSongData(): void {
		this.assertSongIsPlaying();

		// FIXME Move
		// await SavedEdits.removeSongInfo(this.currentSong);

		// this.currentSong.resetInfo();

		this.unprocessSong();
		// this.processSong();
	}

	/**
	 * Make the controller to ignore current song.
	 */
	skipCurrentSong(): void {
		this.assertSongIsPlaying();

		this.setMode(ControllerMode.Skipped);

		this.currentSong.setFlag('isSkipped', true);

		this.playbackTimer.reset();
		this.replayDetectionTimer.reset();

		this.songUpdateListener.onSongUpdated(this);
	}

	/**
	 * Get connector match object.
	 *
	 * @return Connector
	 */
	getConnector(): ConnectorEntry {
		return this.connector;
	}

	/**
	 * Get current song as plain object.
	 *
	 * @return Song copy
	 */
	getCurrentSong(): Song {
		return this.currentSong;
	}

	/**
	 * Get current controller mode.
	 *
	 * @return Controller mode
	 */
	getMode(): ControllerMode {
		return this.mode;
	}

	/**
	 * Sets data for current song from user input.
	 *
	 * @param data Object contains song data
	 */
	setUserSongData(data: EditedSongInfo): void {
		this.assertSongIsPlaying();

		if (this.currentSong.getFlag('isScrobbled')) {
			throw new Error('Unable to set user data for scrobbled song');
		}

		// FIXME Move
		// await SavedEdits.saveSongInfo(this.currentSong, data);

		this.unprocessSong();
		// this.processSong();
	}

	/**
	 * Send request to love or unlove current song.
	 *
	 * @param loveStatus Flag indicated song is loved
	 */
	async toggleLove(loveStatus: LoveStatus): Promise<void> {
		this.assertSongIsPlaying();

		if (!this.currentSong.isValid()) {
			throw new Error('No valid song is now playing');
		}

		await this.scrobblerManager.sendLoveRequest(
			this.currentSong,
			loveStatus
		);

		this.currentSong.setLoveStatus(loveStatus);
		this.songUpdateListener.onSongUpdated(this);
	}

	/**
	 * React on state change.
	 *
	 * @param newState State of connector
	 */
	async onStateChanged(newState: ParsedSongInfo): Promise<void> {
		if (!this.isEnabled) {
			return;
		}

		/*
		 * Empty state has same semantics as reset; even if isPlaying,
		 * we don't have enough data to use.
		 */
		if (isStateEmpty(newState)) {
			return this.processEmptyState(newState);
		}

		const isSongChanged = this.isSongChanged(newState);
		this.previousState = newState;

		if (isSongChanged || this.isReplayingSong) {
			if (newState.isPlaying) {
				if (this.isNeedToAddSongToScrobbleStorage()) {
					await this.addSongToScrobbleStorage();
				}

				this.processNewState(newState);
				await this.processSong();
			} else {
				this.reset();
			}
		} else {
			this.processCurrentState(newState);
		}
	}

	private setMode(mode: ControllerMode): void {
		this.mode = mode;
		this.modeListener.onModeChanged(this);
	}

	private async processEmptyState(state: ParsedSongInfo): Promise<void> {
		if (this.currentSong) {
			this.debugLog('Received empty state - resetting');

			if (this.isNeedToAddSongToScrobbleStorage()) {
				await this.addSongToScrobbleStorage();
			}
			this.reset();
		}

		if (state.isPlaying) {
			this.debugLog(
				`State from connector doesn't contain enough information about the playing track: ${toString(
					state
				)}`,
				'warn'
			);
		}
	}

	/**
	 * Process connector state as new one.
	 *
	 * @param newState Connector state
	 */
	private processNewState(newState: ConnectorState): void {
		/*
		 * We've hit a new song (or replaying the previous one)
		 * clear any previous song and its bindings.
		 */
		this.resetState();
		this.currentSong = new SongImpl(newState);
		this.currentSong.setFlag('isReplaying', this.isReplayingSong);

		this.debugLog(`New song detected: ${toString(newState)}`);

		if (!this.shouldScrobblePodcasts && newState.isPodcast) {
			this.skipCurrentSong();
			return;
		}

		/*
		 * Start the timer, actual time will be set after processing
		 * is done; we can call doScrobble directly, because the timer
		 * will be allowed to trigger only after the song is validated.
		 */
		this.playbackTimer.start(() => {
			this.scrobbleSong();
		});

		this.replayDetectionTimer.start(() => {
			this.debugLog('Replaying song...');
			this.isReplayingSong = true;
		});

		/*
		 * If we just detected the track and it's not playing yet,
		 * pause the timer right away; this is important, because
		 * isPlaying flag binding only calls pause/resume which assumes
		 * the timer is started.
		 */
		if (!newState.isPlaying) {
			this.playbackTimer.pause();
			this.replayDetectionTimer.pause();
		}

		this.isReplayingSong = false;
	}

	/**
	 * Process connector state as current one.
	 *
	 * @param newState Connector state
	 */
	private processCurrentState(newState: ConnectorState): void {
		if (this.currentSong.getFlag('isSkipped')) {
			return;
		}

		const { currentTime, isPlaying, trackArt, duration } = newState;
		const isPlayingStateChanged =
			this.currentSong.isPlaying() !== isPlaying;

		this.currentSong.setCurrentTime(currentTime);
		this.currentSong.setTrackArt(trackArt);
		this.currentSong.setPlaying(isPlaying);

		if (this.isNeedToUpdateDuration(newState)) {
			this.updateSongDuration(duration);
		}

		if (isPlayingStateChanged) {
			this.onPlayingStateChanged(isPlaying);
		}
	}

	/**
	 * Reset controller state.
	 */
	private resetState(): void {
		this.nowPlayingListener.onReset(this);

		this.playbackTimer.reset();
		this.replayDetectionTimer.reset();

		this.currentSong = null;
	}

	/**
	 * Process song using pipeline module.
	 */
	private async processSong(): Promise<void> {
		this.setMode(ControllerMode.Loading);

		await this.songPipeline.process(this.currentSong);

		this.debugLog(
			`Song finished processing: ${this.currentSong.toString()}`
		);

		if (this.currentSong.isValid()) {
			// Processing cleans this flag
			this.currentSong.setFlag('isMarkedAsPlaying', false);

			this.updateTimers(this.currentSong.getDuration());

			/*
			 * If the song is playing, mark it immediately;
			 * otherwise will be flagged in isPlaying binding.
			 */
			if (this.currentSong.isPlaying()) {
				/*
				 * If playback timer is expired, then the extension
				 * will scrobble song immediately, and there's no need
				 * to set song as now playing. We should dispatch
				 * a "now playing" event, though.
				 */
				if (!this.playbackTimer.isExpired()) {
					this.setSongNowPlaying();
				} else {
					this.nowPlayingListener.onNowPlaying(this);
				}
			} else {
				this.setMode(ControllerMode.Base);
			}
		} else {
			this.setSongNotRecognized();
		}

		this.songUpdateListener.onSongUpdated(this);
	}

	/**
	 * Called when song was already flagged as processed, but now is
	 * entering the pipeline again.
	 */
	private unprocessSong(): void {
		this.debugLog(`Song unprocessed: ${this.currentSong.toString()}`);
		this.debugLog('Clearing playback timer destination time');

		// this.currentSong.resetData();
		this.currentSong = null;

		this.playbackTimer.update(null);
		this.replayDetectionTimer.update(null);
	}

	/**
	 * Called when playing state is changed.
	 *
	 * @param value New playing state
	 */
	private onPlayingStateChanged(value: boolean): void {
		this.debugLog(`isPlaying state changed to ${value.toString()}`);

		if (value) {
			this.playbackTimer.resume();
			this.replayDetectionTimer.resume();

			// Maybe the song was not marked as playing yet
			if (
				!this.currentSong.getFlag('isMarkedAsPlaying') &&
				this.currentSong.isValid()
			) {
				this.setSongNowPlaying();
			} else {
				// Resend current mode
				this.setMode(this.mode);
			}
		} else {
			this.playbackTimer.pause();
			this.replayDetectionTimer.pause();
		}
	}

	/**
	 * Check if song is changed by given connector state.
	 *
	 * @param newState Connector state
	 *
	 * @return Check result
	 */
	private isSongChanged(newState: ConnectorState): boolean {
		if (!this.previousState) {
			return true;
		}

		for (const field of fieldsToCheckSongChange) {
			if (newState[field] !== this.previousState[field]) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Check if song duration should be updated.
	 *
	 * @param newState Connector state
	 *
	 * @return Check result
	 */
	private isNeedToUpdateDuration(newState: ParsedSongInfo): boolean {
		return (
			newState.duration &&
			this.currentSong.getDuration() !== newState.duration
		);
	}

	/**
	 * Add current song to scrobble storage.
	 *
	 * @param scrobblerIds Array of scrobbler IDs
	 */
	private async addSongToScrobbleStorage(
		scrobblerIds?: string[]
	): Promise<void> {
		let boundScrobblerIds = scrobblerIds;
		if (!boundScrobblerIds) {
			boundScrobblerIds = Array.from(
				this.scrobblerManager
			).map((scrobbler) => scrobbler.getId());
		}

		// TODO Fix
		// await ScrobbleStorage.addSong(
		// 	this.currentSong,
		// 	boundScrobblerIds
		// );
	}

	/**
	 * Check if the current song should be saved to the scrobble storage.
	 *
	 * @return Check result
	 */
	private isNeedToAddSongToScrobbleStorage(): boolean {
		if (this.currentSong && !this.currentSong.isValid()) {
			const secondsToScrobble = this.getSecondsToScrobble(
				this.currentSong.getDuration()
			);
			if (secondsToScrobble !== -1) {
				return this.playbackTimer.getElapsed() >= secondsToScrobble;
			}
		}

		return false;
	}

	/**
	 * Update song duration value.
	 *
	 * @param duration Duration in seconds
	 */
	private updateSongDuration(duration: number): void {
		this.debugLog(`Update duration: ${duration}`);

		this.currentSong.setDuration(duration);

		if (this.currentSong.isValid()) {
			this.updateTimers(duration);
		}
	}

	/**
	 * Update internal timers.
	 *
	 * @param duration Song duration in seconds
	 */
	private updateTimers(duration: number): void {
		if (this.playbackTimer.isExpired()) {
			this.debugLog('Attempt to update expired timers', 'warn');
			return;
		}

		const secondsToScrobble = this.getSecondsToScrobble(duration);
		if (secondsToScrobble !== -1) {
			this.playbackTimer.update(secondsToScrobble);
			this.replayDetectionTimer.update(duration);

			const remainedSeconds = this.playbackTimer.getRemainingSeconds();
			this.debugLog(
				`The song will be scrobbled in ${remainedSeconds} seconds`
			);
			this.debugLog(`The song will be repeated in ${duration} seconds`);
		} else {
			this.debugLog('The song is too short to scrobble');
		}
	}

	/**
	 * Contains all actions to be done when song is ready to be marked as
	 * now playing.
	 */
	private async setSongNowPlaying(): Promise<void> {
		this.currentSong.setFlag('isMarkedAsPlaying', true);

		const results = await this.scrobblerManager.sendNowPlayingRequest(
			this.currentSong
		);
		if (isAnyResult(results, ApiCallResult.RESULT_OK)) {
			this.debugLog('Song set as now playing');
			this.setMode(ControllerMode.Playing);
		} else {
			this.debugLog("Song isn't set as now playing");
			this.setMode(ControllerMode.Err);
		}

		this.nowPlayingListener.onNowPlaying(this);
	}

	/**
	 * Notify user that song it not recognized by the extension.
	 */
	private setSongNotRecognized(): void {
		this.setMode(ControllerMode.Unknown);
		this.nowPlayingListener.onNowPlaying(this);
	}

	/**
	 * Called when scrobble timer triggers.
	 * The time should be set only after the song is validated and ready
	 * to be scrobbled.
	 */
	private async scrobbleSong(): Promise<void> {
		const results = await this.scrobblerManager.sendScrobbleRequest(
			this.currentSong
		);
		const failedScrobblerIds = results
			.filter((result) => !result.is(ApiCallResult.RESULT_OK))
			.map((result) => result.getScrobblerId());

		const isAnyOkResult = results.length > failedScrobblerIds.length;
		if (isAnyOkResult) {
			this.debugLog('Scrobbled successfully');

			this.currentSong.setFlag('isScrobbled', true);
			this.setMode(ControllerMode.Scrobbled);

			this.songUpdateListener.onSongUpdated(this);
		} else if (areAllResults(results, ApiCallResult.RESULT_IGNORE)) {
			this.debugLog('Song is ignored by service');
			this.setMode(ControllerMode.Ignored);
		} else {
			this.debugLog('Scrobbling failed', 'warn');
			this.setMode(ControllerMode.Err);
		}

		if (failedScrobblerIds.length > 0) {
			this.addSongToScrobbleStorage(failedScrobblerIds);
		}
	}

	private getSecondsToScrobble(duration: number): number {
		const percent = getOption<number>(SCROBBLE_PERCENT);
		return getSecondsToScrobble(duration, percent);
	}

	private reset(): void {
		this.resetState();
		this.setMode(ControllerMode.Base);
	}

	private assertSongIsPlaying(): void {
		if (!this.currentSong) {
			throw new Error('No song is now playing');
		}
	}

	/**
	 * Print debug message with prefixed tab ID.
	 *
	 * @param text Debug message
	 * @param [logType=log] Log type
	 */
	debugLog(text: string, logType: LogType = 'log'): void {
		const message = `Tab ${this.tabId}: ${text}`;
		debugLog(message, logType);
	}
}

/**
 * Get string representation of given object.
 *
 * @param obj Any object
 *
 * @return String value
 */
function toString(obj: unknown): string {
	return JSON.stringify(obj, null, 2);
}
